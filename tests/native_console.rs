use std::{
    io::Write,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !self.0.try_wait().is_ok_and(|status| status.is_some()) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
#[test]
fn console_quit_exits_with_stdin_pipe_still_open() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_minecraft-companion"))
            .current_dir(dir.path())
            .env("MC_HOST", "localhost")
            .env("MC_USERNAME", "RustBot")
            .env("MC_AUTH", "offline")
            .env("MC_VERSION", "1.21.4")
            .env("AUTHORIZED_PLAYERS", "Steve")
            .env("MEMORY_FILE", "")
            .env("DISCONNECT_WITHOUT_HUMANS", "true")
            .env("MAX_RECONNECT_ATTEMPTS", "0")
            .env("LOG_LEVEL", "silent")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    // Oversized input is drained as one line, not parsed as trailing commands.
    let stdin = child.0.stdin.as_mut().unwrap();
    stdin.write_all(&vec![b'x'; 1024]).unwrap();
    stdin.write_all(b"\nquit\n").unwrap();
    stdin.flush().unwrap();
    // Keep ChildStdin alive: dropping it would send EOF and mask the old bug.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "quit hung while stdin stayed open"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
