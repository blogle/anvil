use anvil_api::{CheckConclusion, CheckStatus, ExternalState, TurnContext, Verdict};
use anvild::strategy::{
    parse, prompt_hash, resolve, DefaultStrategy, SessionContinuity, StrategyError,
    DEFAULT_SESSION_TOKENS,
};
use serde_json::json;

fn ctx() -> TurnContext {
    TurnContext {
        campaign_name: "payments refactor".to_owned(),
        campaign_context: "We are splitting the monolith service by service.".to_owned(),
        commission_title: "split invoice service".to_owned(),
        commission_spec: "Extract the invoice line rendering into its own service.".to_owned(),
        repo: "acme/payments".to_owned(),
        target_ref: "main".to_owned(),
        target_sha: "a41f2c".to_owned(),
        branch: "anvil/payments-refactor/invoice-split".to_owned(),
        wave: 1,
        attempt_n: 2,
        obligations: vec![
            "invoice rendering moves to invoices/service.go".to_owned(),
            "the existing payments suite stays green".to_owned(),
        ],
        gaps: vec!["check failed: go test".to_owned()],
        external: ExternalState {
            checks: vec![
                CheckStatus {
                    name: "go test".to_owned(),
                    conclusion: CheckConclusion::Fail,
                },
                CheckStatus {
                    name: "golangci-lint".to_owned(),
                    conclusion: CheckConclusion::Pass,
                },
            ],
            mergeable: false,
            head_moved: false,
            work_present: true,
        },
    }
}

#[test]
fn parse_defaults_when_config_is_empty() {
    assert_eq!(
        parse(&json!(null)).unwrap(),
        DefaultStrategy {
            session: SessionContinuity::Continuous,
            verify_cmd: None,
            turn_timeout_secs: None,
            session_tokens: DEFAULT_SESSION_TOKENS,
            ignore_checks: Vec::new(),
        }
    );
    assert_eq!(parse(&json!({})).unwrap(), DefaultStrategy::default());
    assert_eq!(
        parse(&json!({"name": "default"})).unwrap(),
        DefaultStrategy::default()
    );
}

#[test]
fn parse_reads_budget_watchdog_and_session_knobs() {
    let strategy = parse(&json!({
        "session": "fresh",
        "turn_timeout_secs": 300,
        "session_tokens": 50_000,
        "ignore_checks": ["Mergify Merge Protections"],
    }))
    .unwrap();
    assert_eq!(strategy.session, SessionContinuity::Fresh);
    assert_eq!(strategy.turn_timeout_secs, Some(300));
    assert_eq!(strategy.session_tokens, 50_000);
    assert_eq!(strategy.ignore_checks, vec!["Mergify Merge Protections"]);

    assert!(matches!(
        parse(&json!({"turn_timeout_secs": 0})).unwrap_err(),
        StrategyError::Invalid {
            field: "turn_timeout_secs",
            ..
        }
    ));
    assert!(matches!(
        parse(&json!({"session_tokens": "much"})).unwrap_err(),
        StrategyError::Invalid {
            field: "session_tokens",
            ..
        }
    ));
    assert!(matches!(
        parse(&json!({"ignore_checks": "nope"})).unwrap_err(),
        StrategyError::Invalid {
            field: "ignore_checks",
            ..
        }
    ));
}

#[test]
fn parse_rejects_unknown_names_and_bad_fields() {
    assert!(matches!(
        parse(&json!({"name": "reviewer"})),
        Err(StrategyError::Unknown { name }) if name == "reviewer"
    ));
    assert!(matches!(
        parse(&json!({"session": "sometimes"})),
        Err(StrategyError::Invalid {
            field: "session",
            ..
        })
    ));
    assert!(matches!(
        parse(&json!({"verify_cmd": 3})),
        Err(StrategyError::Invalid {
            field: "verify_cmd",
            ..
        })
    ));
    assert!(matches!(
        parse(&json!("default")),
        Err(StrategyError::Malformed { .. })
    ));
}

#[test]
fn parse_reads_the_knobs() {
    let strategy = parse(&json!({
        "name": "default",
        "session": "continuous",
        "verify_cmd": "just ci-check",
        "model": "glm-5.3",
    }))
    .unwrap();
    assert_eq!(strategy.session, SessionContinuity::Continuous);
    assert_eq!(strategy.verify_cmd.as_deref(), Some("just ci-check"));
}

#[test]
fn resolve_prefers_commission_over_campaign() {
    let campaign = json!({"model": "glm-5.3"});
    assert_eq!(resolve(&campaign, &json!(null)), campaign);
    assert_eq!(resolve(&campaign, &json!({})), campaign);
    let commission = json!({"model": "glm-5.3", "session": "continuous"});
    assert_eq!(resolve(&campaign, &commission), commission);
    assert_eq!(resolve(&json!(null), &json!(null)), json!(null));
}

#[test]
fn compose_turn_layers_the_prompt_hierarchy() {
    let prompt = DefaultStrategy::default().compose_turn(&ctx());

    let campaign_at = prompt.find("# Campaign: payments refactor").unwrap();
    let commission_at = prompt.find("# Commission: split invoice service").unwrap();
    let obligations_at = prompt.find("# Obligations").unwrap();
    let gaps_at = prompt.find("# Current gaps").unwrap();
    let state_at = prompt.find("# Live state").unwrap();
    let instructions_at = prompt.find("# Operating instructions (attempt 2)").unwrap();
    assert!(campaign_at < commission_at);
    assert!(commission_at < obligations_at);
    assert!(obligations_at < gaps_at);
    assert!(gaps_at < state_at);
    assert!(state_at < instructions_at);

    assert!(prompt.contains("We are splitting the monolith service by service."));
    assert!(prompt.contains("Extract the invoice line rendering into its own service."));
    assert!(prompt.contains("1. invoice rendering moves to invoices/service.go"));
    assert!(prompt.contains("2. the existing payments suite stays green"));
    assert!(prompt.contains("- check FAIL: go test"));
    assert!(prompt.contains("- check PASS: golangci-lint"));
    assert!(prompt.contains("- mergeable: no"));
    assert!(prompt.contains("- target: main at a41f2c"));
    assert!(prompt.contains("- work branch: anvil/payments-refactor/invoice-split"));
    assert!(prompt.contains("`anvilctl done --notes <summary>`"));
    assert!(prompt.contains("`anvilctl attention <message>`"));
    assert!(prompt.contains("the convergence gate is the PR check suite"));
}

#[test]
fn compose_turn_omits_empty_gaps_and_marks_empty_obligations() {
    let mut context = ctx();
    context.gaps.clear();
    context.obligations.clear();
    let prompt = DefaultStrategy::default().compose_turn(&context);
    assert!(!prompt.contains("# Current gaps"));
    assert!(prompt.contains("None yet. Establish the commission scope with the operator."));
}

#[test]
fn compose_turn_renders_head_movement_and_verify_cmd() {
    let mut context = ctx();
    context.external.head_moved = true;
    let strategy = DefaultStrategy {
        session: SessionContinuity::Fresh,
        verify_cmd: Some("just ci-check".to_owned()),
        turn_timeout_secs: None,
        session_tokens: DEFAULT_SESSION_TOKENS,
        ignore_checks: Vec::new(),
    };
    let prompt = strategy.compose_turn(&context);
    assert!(prompt.contains("- target head moved since admission: rebase onto the new head"));
    assert!(prompt.contains("- before claiming done, run: `just ci-check`"));
    assert!(!prompt.contains("the convergence gate is the PR check suite"));
}

#[test]
fn evaluate_converges_when_checks_pass_and_mergeable() {
    let external = ExternalState {
        checks: vec![
            CheckStatus {
                name: "go test".to_owned(),
                conclusion: CheckConclusion::Pass,
            },
            CheckStatus {
                name: "lint".to_owned(),
                conclusion: CheckConclusion::Inconclusive,
            },
        ],
        mergeable: true,
        head_moved: false,
        work_present: true,
    };
    assert_eq!(
        DefaultStrategy::default().evaluate(&external),
        Verdict::Converge
    );
}

#[test]
fn evaluate_converges_with_no_checks_at_all() {
    let external = ExternalState {
        checks: vec![],
        mergeable: true,
        head_moved: false,
        work_present: true,
    };
    assert_eq!(
        DefaultStrategy::default().evaluate(&external),
        Verdict::Converge
    );
}

#[test]
fn evaluate_collects_failed_checks_as_gaps() {
    let external = ExternalState {
        checks: vec![
            CheckStatus {
                name: "go test".to_owned(),
                conclusion: CheckConclusion::Fail,
            },
            CheckStatus {
                name: "race".to_owned(),
                conclusion: CheckConclusion::Fail,
            },
        ],
        mergeable: true,
        head_moved: true,
        work_present: true,
    };
    assert_eq!(
        DefaultStrategy::default().evaluate(&external),
        Verdict::Continue {
            gaps: vec![
                "check failed: go test".to_owned(),
                "check failed: race".to_owned(),
            ]
        }
    );
}

#[test]
fn a_workless_pr_never_converges_no_matter_how_green_its_seed_checks() {
    let external = ExternalState {
        checks: vec![CheckStatus {
            name: "sdlc / pr-fast".to_owned(),
            conclusion: CheckConclusion::Pass,
        }],
        mergeable: true,
        head_moved: false,
        work_present: false,
    };
    assert_eq!(
        DefaultStrategy::default().evaluate(&external),
        Verdict::Continue {
            gaps: vec![
                "nothing has been committed to the work branch yet: implement the commission, commit, and push"
                    .to_owned(),
            ]
        }
    );
}

#[test]
fn evaluate_ignores_checks_the_operator_excluded() {
    let strategy = DefaultStrategy {
        ignore_checks: vec!["Mergify Merge Protections".to_owned()],
        ..DefaultStrategy::default()
    };
    let external = ExternalState {
        checks: vec![
            CheckStatus {
                name: "Mergify Merge Protections".to_owned(),
                conclusion: CheckConclusion::Fail,
            },
            CheckStatus {
                name: "sdlc / check / clippy".to_owned(),
                conclusion: CheckConclusion::Pass,
            },
        ],
        mergeable: true,
        head_moved: false,
        work_present: true,
    };
    assert_eq!(strategy.evaluate(&external), Verdict::Converge);

    let external = ExternalState {
        checks: vec![CheckStatus {
            name: "sdlc / check / clippy".to_owned(),
            conclusion: CheckConclusion::Fail,
        }],
        mergeable: true,
        head_moved: false,
        work_present: true,
    };
    assert_eq!(
        strategy.evaluate(&external),
        Verdict::Continue {
            gaps: vec!["check failed: sdlc / check / clippy".to_owned()]
        }
    );
}

#[test]
fn evaluate_waits_on_pending_checks() {
    let external = ExternalState {
        checks: vec![CheckStatus {
            name: "go test".to_owned(),
            conclusion: CheckConclusion::Pending,
        }],
        mergeable: true,
        head_moved: false,
        work_present: true,
    };
    assert_eq!(
        DefaultStrategy::default().evaluate(&external),
        Verdict::Pending
    );
}

#[test]
fn evaluate_reprompts_on_head_movement_and_conflicts() {
    let moved = ExternalState {
        checks: vec![],
        mergeable: true,
        head_moved: true,
        work_present: true,
    };
    assert!(matches!(
        DefaultStrategy::default().evaluate(&moved),
        Verdict::Continue { gaps } if gaps.len() == 1 && gaps[0].contains("rebase")
    ));

    let conflicted = ExternalState {
        checks: vec![],
        mergeable: false,
        head_moved: false,
        work_present: true,
    };
    assert!(matches!(
        DefaultStrategy::default().evaluate(&conflicted),
        Verdict::Continue { gaps } if gaps.len() == 1 && gaps[0].contains("conflicts")
    ));
}

#[test]
fn check_conclusions_classify_provider_states() {
    assert_eq!(CheckConclusion::classify("success"), CheckConclusion::Pass);
    assert_eq!(CheckConclusion::classify("failure"), CheckConclusion::Fail);
    assert_eq!(
        CheckConclusion::classify("timed_out"),
        CheckConclusion::Fail
    );
    assert_eq!(
        CheckConclusion::classify("action_required"),
        CheckConclusion::Fail
    );
    assert_eq!(
        CheckConclusion::classify("pending"),
        CheckConclusion::Pending
    );
    assert_eq!(
        CheckConclusion::classify("queued"),
        CheckConclusion::Pending
    );
    assert_eq!(CheckConclusion::classify(""), CheckConclusion::Pending);
    assert_eq!(
        CheckConclusion::classify("neutral"),
        CheckConclusion::Inconclusive
    );
    assert_eq!(
        CheckConclusion::classify("skipped"),
        CheckConclusion::Inconclusive
    );
}

#[test]
fn prompt_hash_is_stable_and_sensitive() {
    let a = prompt_hash("do the thing");
    let b = prompt_hash("do the thing");
    let c = prompt_hash("do another thing");
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert_eq!(a.len(), 64);
    assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()));
}
