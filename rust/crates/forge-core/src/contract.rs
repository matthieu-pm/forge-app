//! JSON boundary helpers shared by the issue and planning document contracts.
//! Optional means absent, never null; normalization preserves that distinction.
use serde_json::{Map, Value};
#[derive(Debug, thiserror::Error)]
#[error("Invalid value for {0}.")]
pub struct ContractError(pub &'static str);
pub type Result<T> = std::result::Result<T, ContractError>;
pub struct Object(Map<String, Value>);
impl Object {
    pub fn new(value: Value, keys: &[&str], strict: bool) -> Result<Self> {
        let Value::Object(mut v) = value else {
            return Err(ContractError("object"));
        };
        if strict && v.keys().any(|key| !keys.contains(&key.as_str())) {
            return Err(ContractError("unknown field"));
        }
        v.retain(|key, _| keys.contains(&key.as_str()));
        Ok(Self(v))
    }
    pub fn required(
        &mut self,
        key: &'static str,
        parse: impl FnOnce(Value) -> Result<Value>,
    ) -> Result<()> {
        let value = self.0.remove(key).ok_or(ContractError(key))?;
        self.0
            .insert(key.into(), parse(value).map_err(|_| ContractError(key))?);
        Ok(())
    }
    pub fn optional(
        &mut self,
        key: &'static str,
        parse: impl FnOnce(Value) -> Result<Value>,
    ) -> Result<()> {
        if self.0.contains_key(key) {
            self.required(key, parse)?;
        }
        Ok(())
    }
    pub fn default(
        &mut self,
        key: &'static str,
        value: Value,
        parse: impl FnOnce(Value) -> Result<Value>,
    ) -> Result<()> {
        if !self.0.contains_key(key) {
            self.0.insert(key.into(), value);
        }
        self.required(key, parse)
    }
    pub fn finish(self) -> Value {
        Value::Object(self.0)
    }
}
pub fn text(v: Value, min: usize, max: usize, trim: bool) -> Result<Value> {
    let Value::String(s) = v else {
        return Err(ContractError("text"));
    };
    let s = if trim {
        crate::text::trim(&s).to_owned()
    } else {
        s
    };
    if !(min..=max).contains(&crate::text::length(&s)) {
        return Err(ContractError("text length"));
    }
    Ok(Value::String(s))
}
pub fn string(v: Value) -> Result<Value> {
    text(v, 0, usize::MAX, false)
}
pub fn boolean(v: Value) -> Result<Value> {
    if !v.is_boolean() {
        return Err(ContractError("boolean"));
    }
    Ok(v)
}
pub fn number(v: Value, min: f64, max: f64, integer: bool) -> Result<Value> {
    let n = v.as_f64().ok_or(ContractError("number"))?;
    if !n.is_finite()
        || n < min
        || n > max
        || (integer && (n.fract() != 0.0 || n.abs() > 9007199254740991.0))
    {
        return Err(ContractError("number range"));
    }
    Ok(if integer { Value::from(n as i64) } else { v })
}
pub fn integer(v: Value) -> Result<Value> {
    number(v, 0.0, 9007199254740991.0, true)
}
pub fn enumeration(v: Value, values: &[&str]) -> Result<Value> {
    if !v.as_str().is_some_and(|s| values.contains(&s)) {
        return Err(ContractError("choice"));
    }
    Ok(v)
}
pub fn nullable(v: Value, parse: impl FnOnce(Value) -> Result<Value>) -> Result<Value> {
    if v.is_null() { Ok(v) } else { parse(v) }
}
pub fn record(v: Value) -> Result<Value> {
    if !v.is_object() {
        return Err(ContractError("record"));
    }
    Ok(v)
}
pub fn list(
    v: Value,
    min: usize,
    max: usize,
    parse: impl Fn(Value) -> Result<Value>,
) -> Result<Value> {
    let Value::Array(a) = v else {
        return Err(ContractError("list"));
    };
    if !(min..=max).contains(&a.len()) {
        return Err(ContractError("list length"));
    }
    a.into_iter()
        .map(parse)
        .collect::<Result<Vec<_>>>()
        .map(Value::Array)
}
pub fn uuid(v: Value) -> Result<Value> {
    if !v.as_str().is_some_and(crate::text::is_uuid) {
        return Err(ContractError("UUID"));
    }
    Ok(v)
}
pub fn date(v: Value) -> Result<Value> {
    let s = v.as_str().ok_or(ContractError("date"))?;
    if s.len() != 10
        || !s.as_bytes().iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
        || chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_err()
    {
        return Err(ContractError("date"));
    }
    Ok(v)
}
pub fn datetime(v: Value) -> Result<Value> {
    let v = pattern(
        v,
        r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]+)?Z$",
    )?;
    let s = v.as_str().ok_or(ContractError("timestamp"))?;
    if s.len() < 20 || !s.ends_with('Z') || chrono::DateTime::parse_from_rfc3339(s).is_err() {
        return Err(ContractError("timestamp"));
    }
    Ok(v)
}
pub fn url(v: Value, http: bool) -> Result<Value> {
    let s = v.as_str().ok_or(ContractError("URL"))?;
    // Zod's URL boundary trims ECMAScript whitespace and removes ASCII tabs
    // and newlines without otherwise serializing or canonicalizing the URL.
    let s = crate::text::trim(s).replace(['\t', '\n', '\r'], "");
    if url::Url::parse(&s).is_err()
        || (http
            && !(s.to_lowercase().starts_with("http://")
                || s.to_lowercase().starts_with("https://")))
    {
        return Err(ContractError("URL"));
    }
    Ok(Value::String(s))
}
pub fn pattern(v: Value, pattern: &'static str) -> Result<Value> {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex, OnceLock},
    };
    static EXPRESSIONS: OnceLock<Mutex<HashMap<&'static str, Arc<regex::Regex>>>> = OnceLock::new();
    let expression = EXPRESSIONS
        .get_or_init(Default::default)
        .lock()
        .expect("contract expressions")
        .entry(pattern)
        .or_insert_with(|| Arc::new(regex::Regex::new(pattern).expect("constant expression")))
        .clone();
    let s = v.as_str().ok_or(ContractError("text"))?;
    if !expression.is_match(s) {
        return Err(ContractError("pattern"));
    }
    Ok(v)
}
pub fn color(v: Value) -> Result<Value> {
    pattern(v, r"^#[0-9a-fA-F]{6}$")
}
pub fn icon(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["kind", "value", "color"], false)?;
    o.required("kind", |v| enumeration(v, &["icon", "emoji"]))?;
    o.required("value", |v| text(v, 1, 100, false))?;
    o.required("color", color)?;
    Ok(o.finish())
}
