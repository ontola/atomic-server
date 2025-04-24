use url::Url;

fn main() {
    let url1 = Url::parse("did:ad:agent:MVDkLucjukHLJNh+1lIaS0Ph8U3sjJvS1xyYyoO/Oyo=").unwrap();
    println!("url1 path: {:?}", url1.path());
    let url2 = Url::parse("did:ad:cbXxQGm7UBBS5JPvl/NR/p9RJNbSMUjvA7lRYQt9lZvKZrU1FBo6Icl5uctr7i1AMZ/mElWZ3X1dApo5ifzmBg==").unwrap();
    println!("url2 path: {:?}", url2.path());
    let url3 = Url::parse("did:ad:cbXxQGm7UBBS5JPvl/NR/p9RJNbSMUjvA7lRYQt9lZvKZrU1FBo6Icl5uctr7i1AMZ/mElWZ3X1dApo5ifzmBg==/subpath").unwrap();
    println!("url3 path: {:?}", url3.path());
}
