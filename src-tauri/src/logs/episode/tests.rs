//! Episode state machine with an injected clock. The first two tests are the ones CONTRACTS.md
//! invariant 11 requires.

use super::*;

const S: u64 = 1_000;

/// Drives a machine with a fake clock and collects every emission.
struct Sim {
    m: EpisodeMachine,
    now: u64,
    out: Vec<Emission>,
}

impl Sim {
    fn new(tracking: bool) -> Self {
        Self { m: EpisodeMachine::new(EpisodeTimings::default(), tracking), now: 0, out: Vec::new() }
    }

    fn at(&mut self, t: u64, input: Input) -> &mut Self {
        self.advance_to(t);
        let e = self.m.handle(input, t);
        self.out.extend(e);
        self
    }

    /// Ticks every 250 ms up to `t` (what the watcher does at most).
    fn advance_to(&mut self, t: u64) {
        while self.now + 250 < t {
            self.now += 250;
            let e = self.m.handle(Input::Tick, self.now);
            self.out.extend(e);
        }
        self.now = self.now.max(t);
    }
}

fn fatal(anchor: &str, line: u32) -> Input {
    Input::FatalAnchor { anchor: anchor.into(), line }
}

fn ctx(anchor: &str, line: u32) -> Input {
    Input::ContextualAnchor { anchor: anchor.into(), line }
}

fn crash_file(id: &str) -> Input {
    Input::FatalFile { source_id: id.into(), kind: LogKind::CrashReport }
}

fn anchor_trigger(anchor: &str, tier: AnchorTier, line: u32) -> CrashTrigger {
    CrashTrigger::LogAnchor { anchor: anchor.into(), tier, line }
}

// ── Required (invariant 11) ──────────────────────────────────────────────────

#[test]
fn healthy_log_full_of_exceptions_then_normal_quit_emits_nothing() {
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(4242));
    // A healthy modded startup logs plenty of exceptions.
    let mut line = 10;
    for t in (1..=120).step_by(3) {
        s.at(t * S, ctx("Caused by:", line));
        s.at(t * S + 100, ctx("java.lang.ClassNotFoundException", line + 1));
        s.at(t * S + 200, ctx("Mixin apply for mod", line + 2));
        s.at(t * S + 300, ctx("[main/WARN] [mixin]", line + 3));
        line += 40;
    }
    // Played for a while; last exception at ~118.3 s; quits normally 5 minutes later.
    s.at(420 * S, Input::ProcessExited(4242));
    s.advance_to(600 * S);
    assert!(s.out.is_empty(), "{:?}", s.out);
}

#[test]
fn healthy_log_while_game_keeps_running_emits_nothing() {
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(1));
    for t in 1..200 {
        s.at(t * S, ctx("Caused by:", t as u32));
    }
    s.advance_to(1_000 * S);
    assert!(s.out.is_empty());
}

#[test]
fn load_time_failure_only_in_latest_log_then_exit_emits_exactly_one() {
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(77));
    s.at(3 * S, ctx("Caused by:", 120));
    s.at(4 * S, fatal("Incompatible mods found!", 140));
    s.at(4 * S + 10, fatal("Incompatible mods found!", 141)); // second hit: ignored
    s.at(4 * S + 20, fatal("Missing or unsupported mandatory dependencies", 150));
    s.at(5 * S, Input::ProcessExited(77));
    s.advance_to(200 * S);
    assert_eq!(s.out.len(), 1, "{:?}", s.out);
    let e = &s.out[0];
    assert_eq!(e.source, SourceRef { id: "logs/latest.log".into(), kind: LogKind::LatestLog });
    assert_eq!(
        e.triggers,
        vec![
            anchor_trigger("Caused by:", AnchorTier::Contextual, 120),
            anchor_trigger("Incompatible mods found!", AnchorTier::Fatal, 140),
            anchor_trigger("Missing or unsupported mandatory dependencies", AnchorTier::Fatal, 150),
            CrashTrigger::ProcessExit { pid: 77 },
        ]
    );
}

// ── Fatal coalescing ─────────────────────────────────────────────────────────

#[test]
fn crash_report_header_and_exit_coalesce_into_one() {
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(9));
    s.at(10 * S, fatal("---- Minecraft Crash Report ----", 900));
    s.at(10 * S + 300, crash_file("crash-reports/crash-2026-11-03_10.00.00-client.txt"));
    s.at(10 * S + 400, fatal("#@!@# Game crashed!", 1000));
    s.at(11 * S, Input::ProcessExited(9));
    s.advance_to(120 * S);
    assert_eq!(s.out.len(), 1);
    let e = &s.out[0];
    assert_eq!(e.source.kind, LogKind::CrashReport);
    assert_eq!(e.source.id, "crash-reports/crash-2026-11-03_10.00.00-client.txt");
    assert_eq!(e.triggers.len(), 4, "{:?}", e.triggers);
    assert_eq!(e.triggers.last(), Some(&CrashTrigger::ProcessExit { pid: 9 }));
}

#[test]
fn fatal_emits_after_settle_when_the_process_keeps_running() {
    // Fabric shows its incompatible-mods dialog and the process stays alive.
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(5));
    s.at(1_000, fatal("Incompatible mods found!", 3));
    s.advance_to(1_000 + FATAL_SETTLE_MS - 1);
    assert!(s.out.is_empty(), "not before the settle delay");
    s.advance_to(1_000 + FATAL_SETTLE_MS + 250);
    assert_eq!(s.out.len(), 1);
    // The exit after the user closes the dialog is part of the same crash.
    s.at(20 * S, Input::ProcessExited(5));
    s.advance_to(300 * S);
    assert_eq!(s.out.len(), 1);
}

#[test]
fn settle_is_extended_by_new_fatal_inputs_but_capped() {
    let mut s = Sim::new(false);
    for i in 0..30 {
        s.at(i * 1_500, fatal(&format!("fatal {i}"), i as u32));
    }
    // Inputs every 1.5 s keep extending the 2 s settle, until the 10 s cap.
    assert_eq!(s.out.len(), 1);
    let first = &s.out[0];
    assert!(first.triggers.len() >= 6 && first.triggers.len() <= 8, "{}", first.triggers.len());
}

#[test]
fn best_source_prefers_crash_report_then_hs_err() {
    let mut s = Sim::new(false);
    s.at(0, Input::FatalFile { source_id: "hs_err_pid1.log".into(), kind: LogKind::HsErr });
    s.at(100, fatal("# A fatal error has been detected", 1));
    s.advance_to(10 * S);
    assert_eq!(s.out[0].source, SourceRef { id: "hs_err_pid1.log".into(), kind: LogKind::HsErr });

    let mut s = Sim::new(false);
    s.at(0, crash_file("crash-reports/a.txt"));
    s.at(100, Input::FatalFile { source_id: "hs_err_pid1.log".into(), kind: LogKind::HsErr });
    s.at(200, crash_file("crash-reports/b.txt"));
    s.at(300, crash_file("crash-reports/b.txt")); // seen again: ignored
    s.advance_to(10 * S);
    assert_eq!(s.out.len(), 1);
    assert_eq!(s.out[0].source.id, "crash-reports/b.txt");
    assert_eq!(s.out[0].triggers.len(), 3);
}

// ── Contextual window ────────────────────────────────────────────────────────

#[test]
fn contextual_hit_then_exit_within_window_emits_one() {
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(3));
    s.at(10 * S, ctx("Caused by:", 400));
    s.at(12 * S, ctx("Caused by:", 410)); // same anchor: first line kept, window refreshed
    s.at(12 * S + 500, ctx("java.lang.NoClassDefFoundError", 412));
    s.at(12 * S + CONTEXT_WINDOW_MS - 1, Input::ProcessExited(3));
    s.advance_to(200 * S);
    assert_eq!(s.out.len(), 1);
    let e = &s.out[0];
    assert_eq!(e.source.kind, LogKind::LatestLog);
    assert_eq!(
        e.triggers,
        vec![
            anchor_trigger("Caused by:", AnchorTier::Contextual, 400),
            anchor_trigger("java.lang.NoClassDefFoundError", AnchorTier::Contextual, 412),
            CrashTrigger::ProcessExit { pid: 3 },
        ]
    );
}

#[test]
fn contextual_hit_then_exit_after_window_emits_nothing() {
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(3));
    s.at(10 * S, ctx("Caused by:", 400));
    s.at(10 * S + CONTEXT_WINDOW_MS + 1, Input::ProcessExited(3));
    s.advance_to(200 * S);
    assert!(s.out.is_empty());
}

#[test]
fn only_hits_inside_the_window_are_reported() {
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(3));
    s.at(S, ctx("Old warning", 1));
    s.at(100 * S, ctx("Caused by:", 900));
    s.at(101 * S, Input::ProcessExited(3));
    assert_eq!(s.out.len(), 1);
    assert_eq!(
        s.out[0].triggers,
        vec![anchor_trigger("Caused by:", AnchorTier::Contextual, 900), CrashTrigger::ProcessExit { pid: 3 }]
    );
}

#[test]
fn crash_file_folds_in_recent_contextual_hits() {
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(3));
    s.at(5 * S, ctx("Caused by:", 50));
    s.at(6 * S, crash_file("crash-reports/c.txt"));
    s.advance_to(60 * S);
    assert_eq!(s.out.len(), 1);
    assert_eq!(s.out[0].triggers[0], anchor_trigger("Caused by:", AnchorTier::Contextual, 50));
    assert_eq!(s.out[0].source.id, "crash-reports/c.txt");
}

// ── Suppression and new episodes ─────────────────────────────────────────────

#[test]
fn second_crash_after_a_new_process_is_a_second_episode() {
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(10));
    s.at(5 * S, fatal("Incompatible mods found!", 30));
    s.at(6 * S, Input::ProcessExited(10));
    // Restarted at once (well within the 60 s quiet period) and crashed again.
    s.at(15 * S, Input::ProcessStarted(11));
    s.at(20 * S, fatal("Incompatible mods found!", 31));
    s.at(21 * S, Input::ProcessExited(11));
    s.advance_to(100 * S);
    assert_eq!(s.out.len(), 2);
    assert_eq!(s.out[1].triggers.last(), Some(&CrashTrigger::ProcessExit { pid: 11 }));
}

#[test]
fn triggers_after_an_emission_are_suppressed_until_quiet() {
    let mut s = Sim::new(false);
    s.at(0, fatal("A", 1));
    s.advance_to(3 * S);
    assert_eq!(s.out.len(), 1);
    // A crash dump trickling in keeps the suppression alive.
    s.at(30 * S, crash_file("crash-reports/late.txt"));
    s.at(80 * S, fatal("B", 2));
    s.advance_to(130 * S);
    assert_eq!(s.out.len(), 1, "each dropped trigger restarts the quiet period");
    // 60 s without a trigger lifts it.
    s.at(141 * S, fatal("C", 3));
    s.advance_to(150 * S);
    assert_eq!(s.out.len(), 2);
    assert_eq!(s.out[1].triggers, vec![anchor_trigger("C", AnchorTier::Fatal, 3)]);
}

#[test]
fn the_same_pid_seen_again_does_not_lift_suppression() {
    let mut s = Sim::new(true);
    s.at(0, Input::ProcessStarted(8));
    s.at(S, fatal("A", 1));
    s.at(2 * S, Input::ProcessExited(8));
    s.at(3 * S, Input::ProcessStarted(8));
    s.at(4 * S, fatal("A", 9));
    s.advance_to(20 * S);
    assert_eq!(s.out.len(), 1);
}

#[test]
fn without_process_tracking_fatal_emits_after_settle_and_contextual_never() {
    let mut s = Sim::new(false);
    for t in 0..100 {
        s.at(t * S, ctx("Caused by:", t as u32));
    }
    s.advance_to(500 * S);
    assert!(s.out.is_empty(), "contextual never emits without tracking");
    s.at(600 * S, fatal("Mod loading has failed", 10_000));
    s.advance_to(600 * S + FATAL_SETTLE_MS + 250);
    assert_eq!(s.out.len(), 1);
}

#[test]
fn next_deadline_reports_the_settle_time() {
    let mut m = EpisodeMachine::new(EpisodeTimings::default(), true);
    assert_eq!(m.next_deadline(), None);
    assert!(m.handle(fatal("A", 1), 1_000).is_empty());
    assert_eq!(m.next_deadline(), Some(1_000 + FATAL_SETTLE_MS));
    assert_eq!(m.handle(Input::Tick, 1_000 + FATAL_SETTLE_MS).len(), 1);
    assert!(m.is_suppressed());
    assert_eq!(m.next_deadline(), None);
}
