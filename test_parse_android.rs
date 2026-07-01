fn main() {
    let get_project_dirs = || {
        directories::ProjectDirs::from("", "", "atomic-data")
            .expect("Could not find Project directories on your OS")
    };
    
    let a = Some("hello");
    a.unwrap_or_else(|| get_project_dirs().data_dir().to_str().unwrap());
    println!("Done");
}
