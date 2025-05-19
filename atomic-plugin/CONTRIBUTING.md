# Contributing to Atomic Plugin

When updating the bindings, keep the following in mind:
There is a weird issue where the bindings do not work when using the standard `wit_bidgen::generate!` macro.
To get the right bindings change bindings.rs to the following:

```rust
wit_bindgen::generate!({
    path: "wit/class-extender.wit",
    world: "class-extender",
    pub_export_macro: true,
});
```

Then run `cargo component check` on the atomic-plugin crate, for some reason this expands the macro in a way that it actually works.
The only thing left is to mark the following macro as exported:

```rust
#[doc(hidden)]
#[macro_export] // <-- add this line
macro_rules! __export_world_class_extender_cabi {
```
