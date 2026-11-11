use forge_core::template_application as t;
use serde_json::Value;
#[test]
fn creation_inputs_forms_text_and_revision_hashes_match_source() {
    let fixture: Value =
        serde_json::from_str(include_str!("../data/template-application-reference.json")).unwrap();
    for (i, c) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        let result = if c["kind"] == "query" {
            t::query(c["input"].clone())
        } else {
            t::apply(c["input"].clone())
        };
        assert_eq!(
            result.is_ok(),
            c["valid"].as_bool().unwrap(),
            "input {i}: {result:?}"
        );
        if let Ok(v) = result {
            assert_eq!(v, c["output"], "input {i}");
        }
    }
    for (i, c) in fixture["forms"].as_array().unwrap().iter().enumerate() {
        let result = t::form_content(&c["template"], &c["answers"]);
        assert_eq!(
            result.is_ok(),
            c["valid"].as_bool().unwrap(),
            "form {i}: {result:?}"
        );
        match result {
            Ok(v) => {
                assert_eq!(v, c["output"], "form {i}");
                assert_eq!(t::document_text(&v), c["text"], "form text {i}");
            }
            Err(e) => assert_eq!(e, c["message"].as_str().unwrap(), "form error {i}"),
        }
    }
    for c in fixture["texts"].as_array().unwrap() {
        assert_eq!(t::document_text(&c["input"]), c["output"], "{}", c["input"]);
    }
    for c in fixture["revisions"].as_array().unwrap() {
        assert_eq!(
            t::revision(&c["payload"], c["updatedAt"].as_str().unwrap()),
            c["output"].as_str().unwrap()
        );
    }
}
