#[test]
fn test_run_pass_conversions_extern() {
    run_pass("isle_examples/pass/conversions_extern.isle");
}
#[test]
fn test_run_pass_recursion() {
    run_pass("isle_examples/pass/recursion.isle");
}
#[test]
fn test_run_pass_bound_var() {
    run_pass("isle_examples/pass/bound_var.isle");
}
#[test]
fn test_run_pass_nodebug() {
    run_pass("isle_examples/pass/nodebug.isle");
}
#[test]
fn test_run_pass_construct_and_extract() {
    run_pass("isle_examples/pass/construct_and_extract.isle");
}
#[test]
fn test_run_pass_conversions() {
    run_pass("isle_examples/pass/conversions.isle");
}
#[test]
fn test_run_pass_veri_spec() {
    run_pass("isle_examples/pass/veri_spec.isle");
}
#[test]
fn test_run_pass_tutorial() {
    run_pass("isle_examples/pass/tutorial.isle");
}
#[test]
fn test_run_pass_test3() {
    run_pass("isle_examples/pass/test3.isle");
}
#[test]
fn test_run_pass_test2() {
    run_pass("isle_examples/pass/test2.isle");
}
#[test]
fn test_run_pass_prio_trie_bug() {
    run_pass("isle_examples/pass/prio_trie_bug.isle");
}
#[test]
fn test_run_pass_let() {
    run_pass("isle_examples/pass/let.isle");
}
#[test]
fn test_run_pass_test4() {
    run_pass("isle_examples/pass/test4.isle");
}
#[test]
fn test_run_fail_impure_rhs() {
    run_fail("isle_examples/fail/impure_rhs.isle");
}
#[test]
fn test_run_fail_multi_prio() {
    run_fail("isle_examples/fail/multi_prio.isle");
}
#[test]
fn test_run_fail_bound_var_type_mismatch() {
    run_fail("isle_examples/fail/bound_var_type_mismatch.isle");
}
#[test]
fn test_run_fail_error1() {
    run_fail("isle_examples/fail/error1.isle");
}
#[test]
fn test_run_fail_recursion_cycle() {
    run_fail("isle_examples/fail/recursion_cycle.isle");
}
#[test]
fn test_run_fail_recursion_direct() {
    run_fail("isle_examples/fail/recursion_direct.isle");
}
#[test]
fn test_run_fail_multi_internal_etor() {
    run_fail("isle_examples/fail/multi_internal_etor.isle");
}
#[test]
fn test_run_fail_bad_converters() {
    run_fail("isle_examples/fail/bad_converters.isle");
}
#[test]
fn test_run_fail_converter_extractor_constructor() {
    run_fail("isle_examples/fail/converter_extractor_constructor.isle");
}
#[test]
fn test_run_fail_impure_expression() {
    run_fail("isle_examples/fail/impure_expression.isle");
}
#[test]
fn test_run_fail_extra_parens() {
    run_fail("isle_examples/fail/extra_parens.isle");
}
#[test]
fn test_run_link_test() {
    run_link("isle_examples/link/test.isle");
}
#[test]
fn test_run_link_iflets() {
    run_link("isle_examples/link/iflets.isle");
}
#[test]
fn test_run_link_multi_constructor() {
    run_link("isle_examples/link/multi_constructor.isle");
}
#[test]
fn test_run_link_borrows() {
    run_link("isle_examples/link/borrows.isle");
}
#[test]
fn test_run_link_multi_extractor() {
    run_link("isle_examples/link/multi_extractor.isle");
}
#[test]
fn test_run_run_iconst() {
    run_run("isle_examples/run/iconst.isle");
}
#[test]
fn test_run_run_let_shadowing() {
    run_run("isle_examples/run/let_shadowing.isle");
}
#[test]
fn test_run_print_conversions_extern() {
    run_print("isle_examples/pass/conversions_extern.isle");
}
#[test]
fn test_run_print_recursion() {
    run_print("isle_examples/pass/recursion.isle");
}
#[test]
fn test_run_print_bound_var() {
    run_print("isle_examples/pass/bound_var.isle");
}
#[test]
fn test_run_print_nodebug() {
    run_print("isle_examples/pass/nodebug.isle");
}
#[test]
fn test_run_print_construct_and_extract() {
    run_print("isle_examples/pass/construct_and_extract.isle");
}
#[test]
fn test_run_print_conversions() {
    run_print("isle_examples/pass/conversions.isle");
}
#[test]
fn test_run_print_veri_spec() {
    run_print("isle_examples/pass/veri_spec.isle");
}
#[test]
fn test_run_print_tutorial() {
    run_print("isle_examples/pass/tutorial.isle");
}
#[test]
fn test_run_print_test3() {
    run_print("isle_examples/pass/test3.isle");
}
#[test]
fn test_run_print_test2() {
    run_print("isle_examples/pass/test2.isle");
}
#[test]
fn test_run_print_prio_trie_bug() {
    run_print("isle_examples/pass/prio_trie_bug.isle");
}
#[test]
fn test_run_print_let() {
    run_print("isle_examples/pass/let.isle");
}
#[test]
fn test_run_print_test4() {
    run_print("isle_examples/pass/test4.isle");
}
#[test]
fn test_run_print_test() {
    run_print("isle_examples/link/test.isle");
}
#[test]
fn test_run_print_iflets() {
    run_print("isle_examples/link/iflets.isle");
}
#[test]
fn test_run_print_multi_constructor() {
    run_print("isle_examples/link/multi_constructor.isle");
}
#[test]
fn test_run_print_borrows() {
    run_print("isle_examples/link/borrows.isle");
}
#[test]
fn test_run_print_multi_extractor() {
    run_print("isle_examples/link/multi_extractor.isle");
}
#[test]
fn test_run_print_iconst() {
    run_print("isle_examples/run/iconst.isle");
}
#[test]
fn test_run_print_let_shadowing() {
    run_print("isle_examples/run/let_shadowing.isle");
}
