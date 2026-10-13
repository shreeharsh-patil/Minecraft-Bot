use crate::{
    actions::Action,
    intelligence::{Priority, Reflex},
    safety::RateLimit,
    skills::Skills,
    world::{GameError, GameResult},
};
use parking_lot::Mutex;
use std::{
    cmp::Ordering,
    collections::{BinaryHeap, VecDeque},
    sync::Arc,
    time::Instant,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub enum Work {
    Plan(Vec<Action>),
    Reflex(Reflex),
}
#[derive(Debug, Clone)]
pub struct Job {
    pub id: u64,
    pub owner: String,
    pub priority: Priority,
    pub work: Work,
    pub created: Instant,
}
impl PartialEq for Job {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}
impl Eq for Job {}
impl PartialOrd for Job {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Job {
    fn cmp(&self, other: &Self) -> Ordering {
        self.priority
            .cmp(&other.priority)
            .then_with(|| other.id.cmp(&self.id))
    }
}
pub struct Active {
    pub job: Job,
    pub cancel: CancellationToken,
    pub interrupted: bool,
}
pub struct State {
    pub queue: BinaryHeap<Job>,
    pub active: Option<Active>,
    pub stopped: bool,
    pub next: u64,
    pub history: VecDeque<(u64, String)>,
    pub rate: RateLimit,
}
pub struct Scheduler {
    state: Mutex<State>,
    wake: Notify,
    shutdown: CancellationToken,
}
impl Scheduler {
    pub fn new(max_actions: u32, shutdown: CancellationToken) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                queue: BinaryHeap::new(),
                active: None,
                stopped: false,
                next: 1,
                history: VecDeque::new(),
                rate: RateLimit::new(max_actions),
            }),
            wake: Notify::new(),
            shutdown,
        })
    }
    pub fn submit(&self, owner: &str, priority: Priority, work: Work) -> GameResult<u64> {
        let mut s = self.state.lock();
        if self.shutdown.is_cancelled() {
            return Err(GameError::Disconnected);
        }
        if s.queue.len() >= 16 {
            return Err(GameError::Failed("task queue is full".into()));
        }
        if matches!(&work, Work::Reflex(_)) && s.stopped {
            return Err(GameError::Cancelled);
        }
        let same = |j: &Job| {
            j.owner.eq_ignore_ascii_case(owner)
                && match (&j.work, &work) {
                    (Work::Plan(a), Work::Plan(b)) => a == b,
                    (Work::Reflex(a), Work::Reflex(b)) => a == b,
                    _ => false,
                }
        };
        if let Some(j) = s.queue.iter().find(|j| same(j)) {
            return Ok(j.id);
        }
        if let Some(a) = s.active.as_ref().filter(|a| same(&a.job)) {
            return Ok(a.job.id);
        }
        if !s.rate.acquire(Instant::now()) {
            return Err(GameError::Unsafe("global action rate limit reached".into()));
        }
        if priority == Priority::Instruction {
            s.stopped = false;
            s.queue.retain(|j| j.priority != Priority::Instruction);
        }
        if let Some(a) = &mut s.active {
            if priority > a.job.priority
                || priority == Priority::Instruction && a.job.priority == Priority::Instruction
            {
                a.interrupted = priority > a.job.priority;
                a.cancel.cancel();
            }
        }
        let id = s.next;
        s.next += 1;
        s.queue.push(Job {
            id,
            owner: owner.into(),
            priority,
            work,
            created: Instant::now(),
        });
        drop(s);
        self.wake.notify_one();
        Ok(id)
    }
    pub fn stop(&self) {
        let mut s = self.state.lock();
        s.stopped = true;
        s.queue.clear();
        if let Some(a) = &s.active {
            a.cancel.cancel();
        }
        drop(s);
        self.wake.notify_one();
    }
    pub fn stopped(&self) -> bool {
        self.state.lock().stopped
    }
    pub fn status(&self) -> String {
        let s = self.state.lock();
        format!(
            "active={}, queued={}, stopped={}",
            s.active
                .as_ref()
                .map(|a| format!("{} by {}", a.job.id, a.job.owner))
                .unwrap_or_else(|| "none".into()),
            s.queue.len(),
            s.stopped
        )
    }
    pub async fn run(self: Arc<Self>, skills: Arc<Skills>) {
        loop {
            if self.shutdown.is_cancelled() {
                break;
            }
            let notified = self.wake.notified();
            let next = {
                let mut s = self.state.lock();
                let job = s.queue.pop();
                job.map(|job| {
                    let cancel = self.shutdown.child_token();
                    s.active = Some(Active {
                        job: job.clone(),
                        cancel: cancel.clone(),
                        interrupted: false,
                    });
                    (job, cancel)
                })
            };
            let Some((job, cancel)) = next else {
                tokio::select! {_=self.shutdown.cancelled()=>break,_=notified=>{}}
                continue;
            };
            if job.created.elapsed() > skills.config.task_timeout {
                self.state.lock().active = None;
                continue;
            }
            let future = async {
                match &job.work {
                    Work::Plan(actions) => {
                        let mut total = 0;
                        for a in actions {
                            if matches!(a, Action::Stop) {
                                self.stop();
                                skills.game.stop();
                                break;
                            }
                            total += skills.execute(&job.owner, a, &cancel).await?;
                        }
                        Ok(total)
                    }
                    Work::Reflex(Reflex::Escape) => skills.escape(&cancel).await,
                    Work::Reflex(Reflex::Eat) => {
                        skills.game.eat(None, &cancel).await?;
                        Ok(1)
                    }
                    Work::Reflex(Reflex::Defend) => skills.combat(None, 4., None, &cancel).await,
                    Work::Reflex(Reflex::None) => Ok(0),
                }
            };
            let result = tokio::select! {biased;_=cancel.cancelled()=>Err(GameError::Cancelled),r=tokio::time::timeout(skills.config.task_timeout,future)=>r.unwrap_or_else(|_|Err(GameError::Timeout("task deadline".into())))};
            skills.game.stop();
            let resume = {
                let mut s = self.state.lock();
                let active = s.active.take();
                let resumable = matches!(&job.work,Work::Plan(a) if a.len()==1 && matches!(&a[0],Action::FollowPlayer{..}|Action::MoveToPosition{..}|Action::MoveToPlayer{..}));
                let resume = active.is_some_and(|a| a.interrupted)
                    && !s.stopped
                    && resumable
                    && !self.shutdown.is_cancelled();
                let summary = match &result {
                    Ok(n) => format!("completed ({n})"),
                    Err(e) => e.to_string(),
                };
                if s.history.len() == 32 {
                    s.history.pop_front();
                }
                s.history.push_back((job.id, summary));
                if resume {
                    s.queue.push(job.clone());
                }
                resume
            };
            if !resume && matches!(job.work, Work::Plan(_)) {
                match result {
                    Ok(n) => skills.game.say(&job.owner, &format!("Completed ({n}).")),
                    Err(e) => {
                        skills.memory.lock().await.failure(&e.to_string());
                        skills.game.say(&job.owner, &e.to_string());
                    }
                }
            }
        }
        self.stop();
        skills.game.stop();
    }
}
