use url::Url;

fn main() {
    let s = "did:ad:C1PsEdNI7K1D4N2dMVaaHwxwevsl/6pL8rSdejvD+ori3rZb6eafyTgeEVKCHPG0Po3SBQyT7Ea/7pB/Fl8PCg==";
    match Url::parse(s) {
        Ok(u) => {
            println!("Scheme: {}", u.scheme());
            println!("Path: {}", u.path());
            println!("Opaque: {}", u.as_str());
        }
        Err(e) => println!("Error: {}", e),
    }
}
