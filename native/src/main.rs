#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    minecraft_companion::minecraft::run().await
}
