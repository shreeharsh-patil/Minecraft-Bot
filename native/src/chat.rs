use crate::actions::{valid_name, valid_player, Action, Position};

pub const HELP: &str = "!come; !goto x y z; !follow [player] [distance]; !guard player; !stop; !stay; !pickup [item] [count]; !mine block [count]; !deposit [item]; !withdraw [item] [count]; !equip item; !drop item [count]; !eat [item]; !inventory; !status; !remember name; !home; !help";
#[derive(Debug, PartialEq)]
pub enum Input {
    Empty,
    Action(Action),
    Local { name: String, args: Vec<String> },
    Natural(String),
}
fn integer(s: &str) -> Result<i32, String> {
    if s.is_empty()
        || s.len() > 12
        || !s
            .trim_start_matches('-')
            .bytes()
            .all(|c| c.is_ascii_digit())
    {
        return Err("expected an integer".into());
    }
    s.parse().map_err(|_| "integer is out of range".into())
}
fn item(s: Option<&&str>, required: bool) -> Result<Option<String>, String> {
    match s {
        Some(s) => {
            let s = s.to_ascii_lowercase();
            if valid_name(&s) {
                Ok(Some(s))
            } else {
                Err("invalid item name".into())
            }
        }
        None if required => Err("item or block name required".into()),
        None => Ok(None),
    }
}
fn count(s: Option<&&str>) -> Result<Option<u32>, String> {
    s.map(|s| {
        integer(s).and_then(|n| {
            if (1..=2304).contains(&n) {
                Ok(n as u32)
            } else {
                Err("count must be 1..2304".into())
            }
        })
    })
    .transpose()
}
pub fn parse(message: &str, prefix: &str, requester: &str) -> Result<Input, String> {
    let t = message.trim();
    if t.is_empty() {
        return Ok(Input::Empty);
    }
    let Some(body) = t.strip_prefix(prefix) else {
        return Ok(Input::Natural(t.chars().take(500).collect()));
    };
    let words: Vec<_> = body.split_whitespace().collect();
    if words.is_empty() {
        return Ok(Input::Empty);
    }
    let name = words[0].to_ascii_lowercase();
    let args = &words[1..];
    let p = |default: bool| -> Result<String, String> {
        let p = args
            .first()
            .copied()
            .or(if default { Some(requester) } else { None })
            .ok_or("player required")?;
        if valid_player(p) {
            Ok(p.into())
        } else {
            Err("invalid player name".into())
        }
    };
    let a = match name.as_str() {
        "come" => Action::MoveToPlayer {
            player: requester.into(),
            max_distance: None,
        },
        "goto" => {
            if args.len() < 3 {
                return Err("usage: !goto <x> <y> <z>".into());
            }
            Action::MoveToPosition {
                position: Position {
                    x: integer(args[0])?,
                    y: integer(args[1])?,
                    z: integer(args[2])?,
                },
                max_distance: None,
            }
        }
        "follow" => Action::FollowPlayer {
            player: p(true)?,
            distance: args
                .get(1)
                .map(|s| integer(s).map(|n| n as f32))
                .transpose()?,
        },
        "guard" => Action::DefendPlayer {
            player: p(false)?,
            radius: Some(8.),
            duration_ms: None,
        },
        "stop" | "stay" => Action::Stop,
        "mine" => Action::MineBlock {
            block_name: item(args.first(), true)?.unwrap(),
            count: count(args.get(1))?.unwrap_or(16),
        },
        "equip" => Action::EquipItem {
            item: item(args.first(), true)?.unwrap(),
        },
        "drop" => Action::DropItem {
            item: item(args.first(), true)?.unwrap(),
            count: count(args.get(1))?,
            destination: None,
        },
        "deposit" => Action::DepositItems {
            item: item(args.first(), false)?,
            location: None,
        },
        "withdraw" => Action::WithdrawItems {
            item: item(args.first(), false)?,
            count: count(args.get(1))?,
            location: None,
        },
        "pickup" => Action::PickupItems {
            item: item(args.first(), false)?,
            count: count(args.get(1))?,
            radius: None,
        },
        "eat" => Action::Eat {
            item: item(args.first(), false)?,
        },
        "inventory" | "status" | "remember" | "home" | "help" => {
            return Ok(Input::Local {
                name,
                args: args.iter().map(|s| s.to_string()).collect(),
            })
        }
        _ => return Ok(Input::Natural(t.chars().take(500).collect())),
    };
    a.validate(512, 256)?;
    Ok(Input::Action(a))
}
