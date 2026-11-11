use super::*;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Engaged {
    issue_id: Uuid,
}
struct Engagement<'a> {
    input: &'a Value,
    issue: Uuid,
    team: Uuid,
}
#[async_trait]
impl CommandHandler for Engagement<'_> {
    type Output = Engaged;
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        _value: Option<&Engaged>,
    ) -> Result<(), StoreError> {
        mutation_fence(connection, actor).await?;
        fields::require_team(connection, actor, self.team).await?;
        if policy::issue(connection, actor, self.issue, false)
            .await?
            .team_id
            != self.team
        {
            return Err(StoreError::Forbidden);
        }
        Ok(())
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<Engaged>, StoreError> {
        sqlx::query("SELECT public.forge_lock_issue_graph($1)")
            .bind(&actor.workspace_id)
            .execute(&mut *connection)
            .await?;
        let mut properties: Value = sqlx::query_scalar(
            "SELECT properties FROM issues WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(&actor.workspace_id)
        .bind(self.issue)
        .fetch_optional(&mut *connection)
        .await?
        .ok_or(StoreError::Forbidden)?;
        self.authorize(connection, actor, None).await?;
        let subscribed = text(self.input, "action") == "subscription";
        let changed;
        if subscribed {
            let mut ids = contract::subscriber_ids(text(&properties, "subscribers"));
            let desired = self.input["subscribed"] == true;
            changed = ids.contains(&actor.user_id) != desired;
            if desired {
                if !ids.contains(&actor.user_id) {
                    ids.push(actor.user_id.clone());
                }
            } else {
                ids.retain(|id| id != &actor.user_id);
            }
            properties["subscribers"] = json!(ids.join(", "));
        } else {
            let emoji = text(self.input, "emoji");
            if !contract::allowed_reaction(emoji) {
                return Err(StoreError::IssueRejected(
                    "Choose an emoji from the reaction picker.",
                ));
            }
            let target = if let Some(id) = self.input.get("commentId") {
                properties
                    .get_mut("comments")
                    .and_then(Value::as_array_mut)
                    .and_then(|comments| {
                        comments
                            .iter_mut()
                            .find(|c| c["id"] == *id && c["deleted"] != true)
                    })
                    .ok_or(StoreError::IssueRejected(
                        "This comment is no longer available for reactions.",
                    ))?
            } else {
                &mut properties
            };
            let previous = target
                .get("reactions")
                .filter(|v| !v.is_null())
                .map(|v| v.as_array().cloned().ok_or(StoreError::InvalidInput))
                .transpose()?
                .unwrap_or_default();
            let mut users = Vec::new();
            for r in &previous {
                if contract::normalize_emoji(text(r, "emoji")) == emoji {
                    for id in r["users"].as_array().ok_or(StoreError::InvalidInput)? {
                        let id = id.as_str().ok_or(StoreError::InvalidInput)?.to_owned();
                        if !users.contains(&id) {
                            users.push(id);
                        }
                    }
                }
            }
            let desired = self.input["present"] == true;
            changed = users.contains(&actor.user_id) != desired;
            if desired {
                if !users.contains(&actor.user_id) {
                    users.push(actor.user_id.clone());
                }
            } else {
                users.retain(|id| id != &actor.user_id);
            }
            users.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let mut reactions: Vec<_> = previous
                .into_iter()
                .filter(|r| contract::normalize_emoji(text(r, "emoji")) != emoji)
                .collect();
            if !users.is_empty() {
                reactions.push(json!({"emoji":emoji,"users":users}));
            }
            if reactions.len() > 100 {
                return Err(StoreError::IssueRejected(
                    "This discussion already has 100 different reactions.",
                ));
            }
            target["reactions"] = json!(reactions);
        }
        if changed {
            sqlx::query("UPDATE issues SET properties=$1 WHERE id=$2")
                .bind(properties)
                .bind(self.issue)
                .execute(connection)
                .await?;
        }
        let mut payload = json!({"issueId":self.issue,"teamId":self.team,"actorId":actor.user_id});
        if subscribed {
            payload["subscribed"] = self.input["subscribed"].clone();
        } else {
            for key in ["commentId", "emoji", "present"] {
                if let Some(v) = self.input.get(key) {
                    payload[key] = v.clone();
                }
            }
        }
        Ok(CommandResult {
            value: Engaged {
                issue_id: self.issue,
            },
            resource_type: "issue".into(),
            resource_id: self.issue.to_string(),
            events: if changed {
                vec![OutboxEvent {
                    topic: if subscribed {
                        "issue.subscription.changed"
                    } else {
                        "issue.reaction.changed"
                    }
                    .into(),
                    payload: payload.as_object().unwrap().clone(),
                }]
            } else {
                vec![]
            },
        })
    }
}
pub async fn engagement(
    database: &Database,
    actor: &Actor,
    input: Value,
) -> Result<Value, StoreError> {
    let input = contract::engagement(input).map_err(|_| StoreError::InvalidInput)?;
    let issue = id(&input, "issueId")?;
    let team = id(&input, "teamId")?;
    match commands::execute(
        database,
        actor,
        Command {
            key: text(&input, "commandKey"),
            operation: "issues.engagement@1",
            input: &input,
            status: 200,
        },
        &Engagement {
            input: &input,
            issue,
            team,
        },
    )
    .await
    {
        Ok(result) => Ok(
            json!({"status":"saved","replayed":result.replayed,"records":read_current(database,actor,&[issue]).await?}),
        ),
        Err(StoreError::IssueRejected(message)) => {
            Ok(json!({"status":"rejected","message":message,"records":[]}))
        }
        Err(error) => Err(error),
    }
}
