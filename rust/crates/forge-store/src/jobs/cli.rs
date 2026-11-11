//! Callable operator command boundary; receives only explicitly selected storage.
//! No dotenv lookup, background execution or environment-derived command target.
use super::*;
use serde_json::json;
use std::collections::HashMap;

pub fn recovery(args: &[String]) -> Result<Recovery> {
    if args.len() < 2
        || !["replay", "resolve"].contains(&args[0].as_str())
        || !(args.len() - 2).is_multiple_of(2)
    {
        return Err(Code::InvalidInput.into());
    }
    let action = &args[0];
    let mut options = HashMap::new();
    for pair in args[2..].as_chunks::<2>().0 {
        if ![
            "--generation",
            "--request",
            "--operator",
            "--reason",
            "--step",
            "--outcome",
            "--quiesced",
            "--evidence",
        ]
        .contains(&pair[0].as_str())
            || options.insert(pair[0].as_str(), pair[1].as_str()).is_some()
        {
            return Err(Code::InvalidInput.into());
        }
    }
    if action == "resolve" && options.get("--quiesced") != Some(&"true") {
        return Err(Code::InvalidInput.into());
    }
    if action == "replay"
        && ["--step", "--outcome", "--quiesced", "--evidence"]
            .iter()
            .any(|k| options.contains_key(k))
    {
        return Err(Code::InvalidInput.into());
    }
    let raw = options.get("--generation").ok_or(Code::InvalidInput)?;
    let raw = forge_core::text::trim(raw);
    let number = if raw.is_empty() {
        0.
    } else if raw.len() > 2
        && [&"0x", &"0X", &"0b", &"0B", &"0o", &"0O"]
            .iter()
            .any(|prefix| raw.starts_with(**prefix))
    {
        let base = match raw.as_bytes()[1] {
            b'x' | b'X' => 16,
            b'b' | b'B' => 2,
            _ => 8,
        };
        u64::from_str_radix(&raw[2..], base).map_err(|_| Code::InvalidInput)? as f64
    } else {
        raw.parse::<f64>().map_err(|_| Code::InvalidInput)?
    };
    if !number.is_finite() {
        return Err(Code::InvalidInput.into());
    }
    let mut input = json!({"jobId":args[1],"generation":number,"requestId":options.get("--request").unwrap_or(&""),"operatorId":options.get("--operator").unwrap_or(&""),"reason":options.get("--reason").unwrap_or(&""),"action":action});
    if action == "resolve" {
        for k in ["step", "outcome", "evidence"] {
            input[k] = json!(options.get(format!("--{k}").as_str()).unwrap_or(&""));
        }
        input["quiesced"] = json!(true);
    }
    Recovery::parse(input)
}
pub async fn command(
    store: &JobStore,
    args: &[String],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Value> {
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["list"] => store.inspect(None).await,
        ["run-sla"] => crate::sla::run_jobs(store.database(), store).await,
        ["inspect", id] if !id.is_empty() => {
            let mut result = store.inspect(Some(uuid(id)?)).await?;
            let recovery = result["jobs"].as_array().ok_or(Code::JobFailed)?.iter().map(|job| {
                let state = job["state"].as_str().unwrap_or("");
                json!({"id":job["id"],"guidance":match state {
                    "reconcile" => "Reconcile started external steps against provider records; resolve each, then replay.",
                    "dead" => "Fix the dependency or handler, then replay this same job. Checkpoints are retained.",
                    "running" => "Wait for the live owner or reap an expired lease. Never clear a live lease.",
                    _ => "No operator recovery required.",
                },"command":if ["dead","reconcile"].contains(&state) { Some(format!("cargo run -p forge-server --bin forge-jobs -- replay {} --generation {} --request <uuid> --operator <uuid> --reason code-fixed",job["id"].as_str().unwrap_or(""),job["generation"])) } else { None }})
            }).collect::<Vec<_>>();
            result["recovery"] = json!(recovery);
            Ok(result)
        }
        ["reap"] => Ok(json!({"recovered":store.reap(None,None).await?})),
        ["schedule-retention"] => Ok(json!({"id":retention::enqueue(store,now).await?})),
        ["run"] => {
            runner::run_next(store, retention::KIND, &retention::WorkflowRetention, None).await
        }
        ["run", id] if !id.is_empty() => {
            runner::run_next(
                store,
                retention::KIND,
                &retention::WorkflowRetention,
                Some(uuid(id)?),
            )
            .await
        }
        _ => store.recover(&recovery(args)?).await,
    }
}
