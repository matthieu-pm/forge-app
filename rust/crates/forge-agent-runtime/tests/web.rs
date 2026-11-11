use async_trait::async_trait;
use forge_agent_runtime::{
    sandbox::Cancellation,
    web::{self, Executor, Failure, Response, Transport},
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use url::Url;
fn reference() -> Value {
    serde_json::from_str(include_str!("../data/web-reference.json")).unwrap()
}
#[test]
fn web_inputs_and_public_address_boundaries_match_the_source() {
    let reference = reference();
    for case in reference["inputs"].as_array().unwrap() {
        let result = forge_core::agents::web::input("web_fetch", case["input"].clone());
        assert_eq!(result.is_ok(), case["valid"] == true, "{case}");
        if let Ok(result) = result {
            assert_eq!(result, case["result"]);
        }
    }
    for case in reference["addresses"].as_array().unwrap() {
        let value = case["value"].as_str().unwrap();
        assert_eq!(
            forge_core::agents::web::private(value),
            case["private"] == true,
            "{value}"
        );
        assert_eq!(
            forge_core::agents::web::loopback(value),
            case["loopback"] == true,
            "{value}"
        );
    }
    for url in [
        "https://127.1",
        "https://0x7f000001",
        "https://2130706433",
        "https://[::ffff:127.0.0.1]",
        "https://user:password@example.com",
    ] {
        assert!(
            web::parse_url(url)
                .and_then(|u| web::public_host(&u))
                .is_err(),
            "{url}"
        );
    }
}
#[test]
fn webpage_conversion_and_output_limits_match_installed_framework_rules() {
    let reference = reference();
    for (i, case) in reference["html"].as_array().unwrap().iter().enumerate() {
        let source = case["input"].as_str().unwrap();
        assert_eq!(
            web::html::plain(source),
            case["text"].as_str().unwrap(),
            "text {i}"
        );
        assert_eq!(
            web::html::markdown(source).unwrap(),
            case["markdown"].as_str().unwrap(),
            "markdown {i}"
        );
    }
    for case in reference["truncation"].as_array().unwrap() {
        let value = case["input"]["text"]
            .as_str()
            .unwrap()
            .repeat(case["input"]["repeat"].as_u64().unwrap() as usize);
        let (output, truncated) = web::head(&value);
        assert_eq!(output, case["result"]["output"]);
        assert_eq!(truncated, case["result"]["truncated"] == true);
    }
}
#[test]
fn complex_html_is_rejected_without_recursive_destruction_or_unbounded_output() {
    assert_eq!(
        web::html::plain(&"keep<script>hidden</script>".repeat(10_000)),
        "keep".repeat(10_000)
    );
    assert_eq!(
        web::html::markdown(&"<!-- comment -->x".repeat(10_000)).unwrap(),
        "x".repeat(10_000)
    );
    for value in [
        "<div>".repeat(2000) + "text" + &"</div>".repeat(2000),
        "<p>x</p>".repeat(50_001),
    ] {
        assert!(matches!(
            web::html::markdown(&value),
            Err(Failure::ComplexHtml)
        ));
    }
}
struct Fake {
    sequence: Mutex<Vec<Value>>,
    calls: Mutex<Vec<Value>>,
    pending: bool,
    entered: tokio::sync::Notify,
    dropped: Arc<AtomicUsize>,
}
impl Fake {
    fn new(sequence: Vec<Value>) -> Self {
        Self {
            sequence: Mutex::new(sequence),
            calls: Mutex::new(vec![]),
            pending: false,
            entered: tokio::sync::Notify::new(),
            dropped: Arc::new(AtomicUsize::new(0)),
        }
    }
}
struct Dropped(Arc<AtomicUsize>);
impl Drop for Dropped {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
#[async_trait]
impl Transport for Fake {
    async fn request(
        &self,
        url: &Url,
        accept: &str,
        retry: bool,
        _: &Cancellation,
    ) -> Result<Response, Failure> {
        let _guard = Dropped(self.dropped.clone());
        self.entered.notify_one();
        if self.pending {
            std::future::pending::<()>().await;
        }
        let value = self.sequence.lock().unwrap().remove(0);
        if value["addresses"].as_array().is_some_and(|values| {
            values
                .iter()
                .any(|v| forge_core::agents::web::private(v.as_str().unwrap()))
        }) {
            return Err(Failure::Private);
        }
        self.calls
            .lock()
            .unwrap()
            .push(json!({"url":url.as_str(),"accept":accept,"retry":retry}));
        let body = value["body"]
            .as_str()
            .unwrap_or("")
            .repeat(value["repeat"].as_u64().unwrap_or(1) as usize)
            .into_bytes();
        if value["headers"]["content-length"]
            .as_str()
            .and_then(|s| s.parse::<usize>().ok())
            .is_some_and(|n| n > web::MAX_BODY)
        {
            return Err(Failure::Size);
        }
        Ok(Response {
            status: value["status"].as_u64().unwrap_or(200) as u16,
            content_type: value["headers"]["content-type"]
                .as_str()
                .unwrap_or("text/html")
                .into(),
            location: value["headers"]["location"].as_str().map(str::to_owned),
            challenge: value["headers"]["cf-mitigated"] == "challenge",
            body,
        })
    }
}
#[tokio::test]
async fn redirects_bounded_reads_formats_and_challenge_retries_follow_source_behavior() {
    let reference = reference();
    for case in reference["responses"].as_array().unwrap() {
        let fake = Arc::new(Fake::new(vec![case["input"].clone()]));
        let executor = Executor {
            transport: fake.clone(),
        };
        let result = executor
            .execute(
                json!({"url":case["input"]["url"],"format":"html"}),
                &Cancellation::default(),
            )
            .await;
        if let Some(error) = case["result"]["error"].as_str() {
            assert_eq!(result.unwrap_err().to_string(), error);
        } else {
            assert_eq!(result.unwrap()["content"], case["result"]["body"]);
        }
        assert_eq!(
            fake.calls.lock().unwrap().len(),
            case["requests"].as_array().unwrap().len()
        );
    }
    for case in reference["executions"].as_array().unwrap() {
        let fake = Arc::new(Fake::new(case["sequence"].as_array().unwrap().clone()));
        let executor = Executor {
            transport: fake.clone(),
        };
        let result = executor
            .execute(case["input"].clone(), &Cancellation::default())
            .await;
        if let Some(error) = case["result"]["error"].as_str() {
            assert_eq!(result.unwrap_err().to_string(), error);
        } else {
            assert_eq!(result.unwrap(), case["result"]);
        }
        let calls = fake.calls.lock().unwrap();
        assert_eq!(calls.len(), case["requests"].as_array().unwrap().len());
        for (i, call) in calls.iter().enumerate() {
            assert_eq!(call["accept"], case["requests"][i]["headers"]["Accept"]);
            assert_eq!(call["retry"], i > 0);
        }
    }
}
#[tokio::test]
async fn cancellation_deadlines_and_invalid_timeouts_never_leave_an_active_fetch() {
    for cancelled in [true, false] {
        let mut fake = Fake::new(vec![]);
        fake.pending = true;
        let fake = Arc::new(fake);
        let executor = Executor {
            transport: fake.clone(),
        };
        let cancellation = Cancellation::default();
        let child = cancellation.clone();
        let task = tokio::spawn(async move {
            executor
                .execute(
                    json!({"url":"https://example.com","timeout":if cancelled{30.0}else{0.1}}),
                    &child,
                )
                .await
        });
        fake.entered.notified().await;
        if cancelled {
            cancellation.cancel();
        }
        assert!(task.await.unwrap().is_err());
        assert_eq!(fake.dropped.load(Ordering::SeqCst), 1);
    }
    let fake = Arc::new(Fake::new(vec![]));
    let executor = Executor {
        transport: fake.clone(),
    };
    for timeout in [-1.0, 0.0001] {
        assert!(matches!(
            executor
                .execute(
                    json!({"url":"https://example.com","timeout":timeout}),
                    &Cancellation::default()
                )
                .await,
            Err(Failure::TimeoutInput)
        ));
    }
    assert!(fake.calls.lock().unwrap().is_empty());
}
