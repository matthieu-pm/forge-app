// Supplies the pinned Rust timezone vocabulary to the TypeScript oracle exporter.
fn main() {
    println!(
        "{}",
        serde_json::to_string(
            &chrono_tz::TZ_VARIANTS
                .iter()
                .map(|tz| tz.name())
                .collect::<Vec<_>>()
        )
        .unwrap()
    );
}
