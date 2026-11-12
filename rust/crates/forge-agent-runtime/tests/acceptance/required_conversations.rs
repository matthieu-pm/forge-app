use super::input_conversations::{finish, parked};
use super::*;
use forge_agent_runtime::{
    engine::Decision,
    journal::{ConversationProof, ResponseProof},
};
fn write(id: &str) -> Value {
    json!({"type":"tool-call","toolCallId":id,"toolName":"update_team","input":{"slug":"forge","settings":{"name":id}}})
}
fn proof(value: &ConversationProof) -> Option<ResponseProof> {
    Some(ResponseProof {
        conversation_id: value.id,
        expected_head_run_id: value.head_run_id,
        expected_generation: value.generation,
    })
}
fn id(channel: &Channel) -> Uuid {
    channel.run_id().parse().unwrap()
}

#[tokio::test]
async fn deferred_deliveries_keep_original_owner_and_canonical_receipts_do_not_replay_after_advancement()
 {
    let f = Fixture::new().await;
    let (lease, state) = parked(&f, vec![write("write-a")]).await;
    let request = state.pending_requests()[0]["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    let initial = f.store.load(&f.channel).await.unwrap();
    let b = f.next("anthropic");
    let b_session = f
        .store
        .admit_at(
            &b,
            f.conversation,
            Some(f.run),
            message("Remember this after approval"),
            f.deadline,
            Some(initial.conversation.as_ref().unwrap().generation),
        )
        .await
        .unwrap();
    assert!(b_session.delivery_only);
    assert_eq!(b_session.state.phase(), Phase::Complete);
    assert_eq!(b_session.state.usage(), (0, 0));
    assert_eq!(b_session.pending_requests.len(), 1);
    assert_eq!(b_session.conversation.as_ref().unwrap().owner_run_id, f.run);
    assert_eq!(b_session.conversation.as_ref().unwrap().head_run_id, id(&b));
    assert!(
        f.store
            .acquire(&b, Uuid::new_v4(), Duration::from_secs(30))
            .await
            .is_err()
    );
    assert!(
        lease
            .append(state.revision(), json!({"type":"fixture.late","data":{}}))
            .await
            .is_err()
    );
    assert!(
        f.store
            .load(&f.channel)
            .await
            .unwrap()
            .continued_by
            .is_none()
    );
    assert!(
        f.store
            .respond_at(
                &f.channel,
                &request,
                Decision::Denied,
                proof(initial.conversation.as_ref().unwrap())
            )
            .await
            .is_err()
    );
    let before = f.store.load(&f.channel).await.unwrap().next_index;
    let receipt = f
        .store
        .respond_at(
            &f.channel,
            &request,
            Decision::Denied,
            proof(b_session.conversation.as_ref().unwrap()),
        )
        .await
        .unwrap();
    assert!(!receipt.replayed && receipt.current_delivery);
    assert_eq!(receipt.stream_start_index, before);
    assert_eq!(receipt.conversation.as_ref().unwrap().head_run_id, id(&b));
    assert_eq!(receipt.conversation.as_ref().unwrap().owner_run_id, f.run);
    let retry = f
        .store
        .respond_at(
            &f.channel,
            &request,
            Decision::Denied,
            proof(b_session.conversation.as_ref().unwrap()),
        )
        .await
        .unwrap();
    assert!(retry.replayed && retry.current_delivery);
    assert_eq!(retry.stream_start_index, before);
    assert!(
        f.store
            .respond_at(
                &f.channel,
                &request,
                Decision::Approved,
                proof(receipt.conversation.as_ref().unwrap())
            )
            .await
            .is_err()
    );
    let completed = finish(&f, &f.channel).await;
    assert!(
        completed
            .history()
            .iter()
            .any(|entry| entry == &message("Remember this after approval"))
    );
    assert_eq!(completed.usage(), (20, 10));
    let c = f.next("openai");
    let c_session = f
        .store
        .admit(
            &c,
            f.conversation,
            Some(id(&b)),
            message("What did I ask you to remember?"),
            f.deadline,
        )
        .await
        .unwrap();
    assert!(
        c_session
            .state
            .history()
            .iter()
            .any(|entry| entry == &message("Remember this after approval"))
    );
    assert_eq!(c_session.state.session_usage(), (20, 10));
    let snapshot = c_session.state.snapshot();
    let retry = f
        .store
        .respond_at(
            &f.channel,
            &request,
            Decision::Denied,
            proof(receipt.conversation.as_ref().unwrap()),
        )
        .await
        .unwrap();
    assert!(retry.replayed && !retry.current_delivery);
    assert_eq!(retry.stream_start_index, before);
    assert_eq!(f.store.load(&c).await.unwrap().state.snapshot(), snapshot);
    assert_eq!(f.head().await, id(&c));
}

#[tokio::test]
async fn partial_canonical_response_completes_delivery_and_second_response_consumes_queued_messages_once()
 {
    let f = Fixture::new().await;
    let (_, state) = parked(&f, vec![write("first"), write("second")]).await;
    let requests = state.pending_requests();
    let first = requests[0]["requestId"].as_str().unwrap();
    let second = requests[1]["requestId"].as_str().unwrap();
    let initial = f
        .store
        .load(&f.channel)
        .await
        .unwrap()
        .conversation
        .unwrap();
    let one = f
        .store
        .respond_at(&f.channel, first, Decision::Denied, proof(&initial))
        .await
        .unwrap();
    let partial = f.store.load(&f.channel).await.unwrap();
    assert_eq!(partial.state.phase(), Phase::Complete);
    assert_eq!(partial.pending_requests.len(), 2);
    let b = f.next("openai");
    let b_session = f
        .store
        .admit_at(
            &b,
            f.conversation,
            Some(f.run),
            message("Yes"),
            f.deadline,
            Some(one.conversation.unwrap().generation),
        )
        .await
        .unwrap();
    assert!(b_session.delivery_only);
    let c = f.next("anthropic");
    let c_session = f
        .store
        .admit_at(
            &c,
            f.conversation,
            Some(id(&b)),
            message("Also keep this"),
            f.deadline,
            Some(b_session.conversation.unwrap().generation),
        )
        .await
        .unwrap();
    assert!(c_session.delivery_only);
    let c_proof = c_session.conversation.unwrap();
    let (a, b) = tokio::join!(
        f.store
            .respond_at(&f.channel, second, Decision::Denied, proof(&c_proof)),
        f.store
            .respond_at(&f.channel, second, Decision::Denied, proof(&c_proof))
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a.replayed, b.replayed);
    assert_eq!(a.stream_start_index, b.stream_start_index);
    let complete = finish(&f, &f.channel).await;
    assert_eq!(complete.usage(), (20, 10));
    let last = complete
        .history()
        .iter()
        .rev()
        .find(|entry| entry["role"] == "user")
        .unwrap();
    let text = last["content"].as_str().unwrap();
    assert!(text.contains("Yes") && text.contains("Also keep this"));
    assert!(complete.pending_requests().is_empty());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM forge_runtime.input_deliveries WHERE run_id=$1")
            .bind(f.run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn matching_composer_does_not_acquire_original_provenance_and_canonical_rebind_uses_latest_history()
 {
    let f = Fixture::new().await;
    let (_, state) = parked(&f, vec![write("write")]).await;
    let request = state.pending_requests()[0]["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    let b = f.next("anthropic");
    let admitted = f
        .store
        .admit(&b, f.conversation, Some(f.run), message("No"), f.deadline)
        .await
        .unwrap();
    assert!(!admitted.delivery_only);
    assert_eq!(admitted.conversation.as_ref().unwrap().owner_run_id, id(&b));
    assert!(admitted.state.issued_request(&request).is_none());
    assert!(
        f.store
            .respond_at(
                &b,
                &request,
                Decision::Approved,
                proof(admitted.conversation.as_ref().unwrap())
            )
            .await
            .is_err()
    );
    let latest = finish(&f, &b).await;
    let receipt = f
        .store
        .respond_at(
            &f.channel,
            &request,
            Decision::Approved,
            proof(admitted.conversation.as_ref().unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(receipt.conversation.as_ref().unwrap().head_run_id, id(&b));
    assert_eq!(receipt.conversation.as_ref().unwrap().owner_run_id, f.run);
    let rebound = f.store.load(&f.channel).await.unwrap();
    assert_eq!(rebound.state.usage(), (10, 5));
    assert_eq!(rebound.state.session_usage(), latest.session_usage());
    assert_eq!(
        &rebound.state.history()[..latest.history().len()],
        latest.history()
    );
    assert!(
        rebound.state.history().last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("This does not authorize an earlier action")
    );
    let completed = finish(&f, &f.channel).await;
    assert_eq!(completed.session_usage(), (30, 15));
    assert_eq!(completed.usage(), (20, 10));
    let new = f.next("openai");
    let live = f.store.conversation(&new, f.conversation).await.unwrap();
    assert_eq!(live.owner_run_id, f.run);
    let foreign = channel(Uuid::new_v4(), "other", "workspace", "openai");
    assert!(
        f.store
            .conversation(&foreign, f.conversation)
            .await
            .is_err()
    );
}
