// We call 'atomic-plugin' programmatically here but in your own project it's easier to install it using `cargo install atomic-plugin`
fn main() {
    #[cfg(not(target_arch = "wasm32"))]
    atomic_plugin::packaging_impl::main().unwrap();
}
