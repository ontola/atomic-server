fn main() -> anyhow::Result<()> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        atomic_plugin::packaging_impl::main()
    }
    #[cfg(target_arch = "wasm32")]
    {
        panic!("This binary is not supported on WASM targets");
    }
}
