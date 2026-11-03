# FOR-133 review and release

PR: https://github.com/matthieu-pm/forge-app/pull/60

The product owner authorized review, fixes, merge, deployment and authenticated
production sidebar verification on 3 November 2026.

## Standards

Independent read-only review of original head
`24f5c0e25b77ba65399b2970023fb0f905783bf8` against main
`6e273c7593c3e553e3eef5c9844cc3b07f3c00da` found no documented-standard violations
or significant baseline code smells. The shared policy, existing command/draft
lifecycle and editor-scoped capture were checked. Findings: zero.

## Spec

One P1 finding was reproduced with two failing regressions on the original head:
Safari can emit `compositionend` before the Enter that confirms IME text. The
capture handler could submit this event before ProseMirror's built-in safeguard.

Commits `eacf9fe` and `3e9ffea` track composition lifecycle in the shared policy
and suppress a single Safari confirmation event within 500 ms. The rich editor
leaves the event intact so ProseMirror consumes its own guard; native textareas
prevent it directly. All supported composers use the lifecycle handlers. Other
browsers retain immediate intentional Enter after composition. Tests cover the
confirmation followed by intentional submission or Shift+Enter, another intervening
key, expiry, and preservation of editor default handling.

Independent re-review confirmed the P1 and the follow-on editor guard interaction
were resolved, with no remaining blocker. Findings: one P1, fixed.

## Release preparation

Main through `a802e6cbfc6b5472eae7474c8444b18c96cf8965` was merged into this branch,
preserving FOR-129 calendar and FOR-131 default-home changes. The reviewed code head
is `3e9ffeacfe941ec7bb7809eed3d18ca5f8f0dfbd`. Local typecheck, changed-file lint,
production build/prerender and protected Workflow verification passed.

No schema migration or configuration change is required. The production identity
was verified read-only as database `neondb`, branch `br-muddy-queen-zaeeysjt`, with
73 migration receipts. The last hash is
`2a4b45a4864cf75dcf4a8691bbdf779050b85dd76ecf944ce5089a1e6f4ef24d`.

Authenticated production verification is scoped to one randomized disposable
workspace/account, including sidebar navigation and comment preference behavior.
The verification fixtures will be removed and the ledger checked again. Final
deployment, checks and cleanup results will be recorded after release.
