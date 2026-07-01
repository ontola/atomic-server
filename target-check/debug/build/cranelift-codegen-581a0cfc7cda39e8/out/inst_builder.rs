/// Convenience methods for building instructions.
///
/// The `InstBuilder` trait has one method per instruction opcode for
/// conveniently constructing the instruction with minimum arguments.
/// Polymorphic instructions infer their result types from the input
/// arguments when possible. In some cases, an explicit `ctrl_typevar`
/// argument is required.
///
/// The opcode methods return the new instruction's result values, or
/// the `Inst` itself for instructions that don't have any results.
///
/// There is also a method per instruction format. These methods all
/// return an `Inst`.
///
/// When an address to a load or store is specified, its integer
/// size is required to be equal to the platform's pointer width.
pub trait InstBuilder<'f>: InstBuilderBase<'f> {
    /// Jump.
    ///
    /// Unconditionally jump to a basic block, passing the specified
    /// block arguments. The number and types of arguments must match the
    /// destination block.
    ///
    /// Inputs:
    ///
    /// - block_call_label: Destination basic block
    /// - block_call_args: Block arguments
    #[allow(non_snake_case, reason = "generated code")]
    fn jump<'a>(mut self, block_call_label: ir::Block, block_call_args: impl IntoIterator<Item = &'a BlockArg>) -> Inst {
        let block_call = self.data_flow_graph_mut().block_call(block_call_label, block_call_args); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1226
        let (inst, dfg) = self.Jump(Opcode::Jump, types::INVALID, block_call); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Conditional branch when cond is non-zero.
    ///
    /// Take the ``then`` branch when ``c != 0``, and the ``else`` branch otherwise.
    ///
    /// Inputs:
    ///
    /// - c: Controlling value to test
    /// - block_then_label: Destination basic block
    /// - block_then_args: Block arguments
    /// - block_else_label: Destination basic block
    /// - block_else_args: Block arguments
    #[allow(non_snake_case, reason = "generated code")]
    fn brif<'a>(mut self, c: ir::Value, block_then_label: ir::Block, block_then_args: impl IntoIterator<Item = &'a BlockArg>, block_else_label: ir::Block, block_else_args: impl IntoIterator<Item = &'a BlockArg>) -> Inst {
        let block_then = self.data_flow_graph_mut().block_call(block_then_label, block_then_args); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1226
        let block_else = self.data_flow_graph_mut().block_call(block_else_label, block_else_args); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1226
        let ctrl_typevar = self.data_flow_graph().value_type(c); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Brif(Opcode::Brif, ctrl_typevar, block_then, block_else, c); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Indirect branch via jump table.
    ///
    /// Use ``x`` as an unsigned index into the jump table ``JT``. If a jump
    /// table entry is found, branch to the corresponding block. If no entry was
    /// found or the index is out-of-bounds, branch to the default block of the
    /// table.
    ///
    /// Note that this branch instruction can't pass arguments to the targeted
    /// blocks. Split critical edges as needed to work around this.
    ///
    /// Do not confuse this with "tables" in WebAssembly. ``br_table`` is for
    /// jump tables with destinations within the current function only -- think
    /// of a ``match`` in Rust or a ``switch`` in C.  If you want to call a
    /// function in a dynamic library, that will typically use
    /// ``call_indirect``.
    ///
    /// Inputs:
    ///
    /// - x: i32 index into jump table
    /// - JT: A jump table.
    #[allow(non_snake_case, reason = "generated code")]
    fn br_table(self, x: ir::Value, JT: ir::JumpTable) -> Inst {
        let (inst, dfg) = self.BranchTable(Opcode::BrTable, types::INVALID, JT, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Encodes an assembly debug trap.
    #[allow(non_snake_case, reason = "generated code")]
    fn debugtrap(self) -> Inst {
        let (inst, dfg) = self.NullAry(Opcode::Debugtrap, types::INVALID); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Terminate execution unconditionally.
    ///
    /// Inputs:
    ///
    /// - code: A trap reason code.
    #[allow(non_snake_case, reason = "generated code")]
    fn trap<T1: Into<ir::TrapCode>>(self, code: T1) -> Inst {
        let code = code.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.Trap(Opcode::Trap, types::INVALID, code); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Trap when zero.
    ///
    /// if ``c`` is non-zero, execution continues at the following instruction.
    ///
    /// Inputs:
    ///
    /// - c: Controlling value to test
    /// - code: A trap reason code.
    #[allow(non_snake_case, reason = "generated code")]
    fn trapz<T1: Into<ir::TrapCode>>(self, c: ir::Value, code: T1) -> Inst {
        let code = code.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(c); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.CondTrap(Opcode::Trapz, ctrl_typevar, code, c); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Trap when non-zero.
    ///
    /// If ``c`` is zero, execution continues at the following instruction.
    ///
    /// Inputs:
    ///
    /// - c: Controlling value to test
    /// - code: A trap reason code.
    #[allow(non_snake_case, reason = "generated code")]
    fn trapnz<T1: Into<ir::TrapCode>>(self, c: ir::Value, code: T1) -> Inst {
        let code = code.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(c); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.CondTrap(Opcode::Trapnz, ctrl_typevar, code, c); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Return from the function.
    ///
    /// Unconditionally transfer control to the calling function, passing the
    /// provided return values. The list of return values must match the
    /// function signature's return types.
    ///
    /// Inputs:
    ///
    /// - rvals: return values
    #[allow(non_snake_case, reason = "generated code")]
    fn return_(mut self, rvals: &[Value]) -> Inst {
        let mut vlist = ir::ValueList::default();
        {
            let pool = &mut self.data_flow_graph_mut().value_lists;
            vlist.extend(rvals.iter().cloned(), pool); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1274
        }
        let (inst, dfg) = self.MultiAry(Opcode::Return, types::INVALID, vlist); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Direct function call.
    ///
    /// Call a function which has been declared in the preamble. The argument
    /// types must match the function's signature.
    ///
    /// Inputs:
    ///
    /// - FN: function to call, declared by `function`
    /// - args: call arguments
    ///
    /// Outputs:
    ///
    /// - rvals: return values
    #[allow(non_snake_case, reason = "generated code")]
    fn call(mut self, FN: ir::FuncRef, args: &[Value]) -> Inst {
        let mut vlist = ir::ValueList::default();
        {
            let pool = &mut self.data_flow_graph_mut().value_lists;
            vlist.extend(args.iter().cloned(), pool); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1274
        }
        let (inst, dfg) = self.Call(Opcode::Call, types::INVALID, FN, vlist); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Indirect function call.
    ///
    /// Call the function pointed to by `callee` with the given arguments. The
    /// called function must match the specified signature.
    ///
    /// Note that this is different from WebAssembly's ``call_indirect``; the
    /// callee is a native address, rather than a table index. For WebAssembly,
    /// `table_addr` and `load` are used to obtain a native address
    /// from a table.
    ///
    /// Inputs:
    ///
    /// - SIG: function signature
    /// - callee: address of function to call
    /// - args: call arguments
    ///
    /// Outputs:
    ///
    /// - rvals: return values
    #[allow(non_snake_case, reason = "generated code")]
    fn call_indirect(mut self, SIG: ir::SigRef, callee: ir::Value, args: &[Value]) -> Inst {
        let ctrl_typevar = self.data_flow_graph().value_type(callee); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let mut vlist = ir::ValueList::default();
        {
            let pool = &mut self.data_flow_graph_mut().value_lists;
            vlist.push(callee, pool); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1272
            vlist.extend(args.iter().cloned(), pool); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1274
        }
        let (inst, dfg) = self.CallIndirect(Opcode::CallIndirect, ctrl_typevar, SIG, vlist); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Direct tail call.
    ///
    /// Tail call a function which has been declared in the preamble. The
    /// argument types must match the function's signature, the caller and
    /// callee calling conventions must be the same, and must be a calling
    /// convention that supports tail calls.
    ///
    /// This instruction is a block terminator.
    ///
    /// Inputs:
    ///
    /// - FN: function to call, declared by `function`
    /// - args: call arguments
    #[allow(non_snake_case, reason = "generated code")]
    fn return_call(mut self, FN: ir::FuncRef, args: &[Value]) -> Inst {
        let mut vlist = ir::ValueList::default();
        {
            let pool = &mut self.data_flow_graph_mut().value_lists;
            vlist.extend(args.iter().cloned(), pool); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1274
        }
        let (inst, dfg) = self.Call(Opcode::ReturnCall, types::INVALID, FN, vlist); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Indirect tail call.
    ///
    /// Call the function pointed to by `callee` with the given arguments. The
    /// argument types must match the function's signature, the caller and
    /// callee calling conventions must be the same, and must be a calling
    /// convention that supports tail calls.
    ///
    /// This instruction is a block terminator.
    ///
    /// Note that this is different from WebAssembly's ``tail_call_indirect``;
    /// the callee is a native address, rather than a table index. For
    /// WebAssembly, `table_addr` and `load` are used to obtain a native address
    /// from a table.
    ///
    /// Inputs:
    ///
    /// - SIG: function signature
    /// - callee: address of function to call
    /// - args: call arguments
    #[allow(non_snake_case, reason = "generated code")]
    fn return_call_indirect(mut self, SIG: ir::SigRef, callee: ir::Value, args: &[Value]) -> Inst {
        let ctrl_typevar = self.data_flow_graph().value_type(callee); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let mut vlist = ir::ValueList::default();
        {
            let pool = &mut self.data_flow_graph_mut().value_lists;
            vlist.push(callee, pool); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1272
            vlist.extend(args.iter().cloned(), pool); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1274
        }
        let (inst, dfg) = self.CallIndirect(Opcode::ReturnCallIndirect, ctrl_typevar, SIG, vlist); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Get the address of a function.
    ///
    /// Compute the absolute address of a function declared in the preamble.
    /// The returned address can be used as a ``callee`` argument to
    /// `call_indirect`. This is also a method for calling functions that
    /// are too far away to be addressable by a direct `call`
    /// instruction.
    ///
    /// Inputs:
    ///
    /// - iAddr (controlling type variable): An integer address type
    /// - FN: function to call, declared by `function`
    ///
    /// Outputs:
    ///
    /// - addr: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn func_addr(self, iAddr: crate::ir::Type, FN: ir::FuncRef) -> Value {
        let (inst, dfg) = self.FuncAddr(Opcode::FuncAddr, iAddr, FN); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Call a function, catching the specified exceptions.
    ///
    /// Call the function pointed to by `callee` with the given arguments. On
    /// normal return, branch to the first target, with function returns
    /// available as `retN` block arguments. On exceptional return,
    /// look up the thrown exception tag in the provided exception table;
    /// if the tag matches one of the targets, branch to the matching
    /// target with the exception payloads available as `exnN` block arguments.
    /// If no tag matches, then propagate the exception up the stack.
    ///
    /// It is the Cranelift embedder's responsibility to define the meaning
    /// of tags: they are accepted by this instruction and passed through
    /// to unwind metadata tables in Cranelift's output. Actual unwinding is
    /// outside the purview of the core Cranelift compiler.
    ///
    /// Payload values on exception are passed in fixed register(s) that are
    /// defined by the platform and ABI. See the documentation on `CallConv`
    /// for details.
    ///
    /// Inputs:
    ///
    /// - callee: function to call, declared by `function`
    /// - args: call arguments
    /// - ET: exception table
    #[allow(non_snake_case, reason = "generated code")]
    fn try_call(mut self, callee: ir::FuncRef, args: &[Value], ET: ir::ExceptionTable) -> Inst {
        let mut vlist = ir::ValueList::default();
        {
            let pool = &mut self.data_flow_graph_mut().value_lists;
            vlist.extend(args.iter().cloned(), pool); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1274
        }
        let (inst, dfg) = self.TryCall(Opcode::TryCall, types::INVALID, callee, ET, vlist); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Call a function, catching the specified exceptions.
    ///
    /// Call the function pointed to by `callee` with the given arguments. On
    /// normal return, branch to the first target, with function returns
    /// available as `retN` block arguments. On exceptional return,
    /// look up the thrown exception tag in the provided exception table;
    /// if the tag matches one of the targets, branch to the matching
    /// target with the exception payloads available as `exnN` block arguments.
    /// If no tag matches, then propagate the exception up the stack.
    ///
    /// It is the Cranelift embedder's responsibility to define the meaning
    /// of tags: they are accepted by this instruction and passed through
    /// to unwind metadata tables in Cranelift's output. Actual unwinding is
    /// outside the purview of the core Cranelift compiler.
    ///
    /// Payload values on exception are passed in fixed register(s) that are
    /// defined by the platform and ABI. See the documentation on `CallConv`
    /// for details.
    ///
    /// Inputs:
    ///
    /// - callee: address of function to call
    /// - args: call arguments
    /// - ET: exception table
    #[allow(non_snake_case, reason = "generated code")]
    fn try_call_indirect(mut self, callee: ir::Value, args: &[Value], ET: ir::ExceptionTable) -> Inst {
        let ctrl_typevar = self.data_flow_graph().value_type(callee); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let mut vlist = ir::ValueList::default();
        {
            let pool = &mut self.data_flow_graph_mut().value_lists;
            vlist.push(callee, pool); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1272
            vlist.extend(args.iter().cloned(), pool); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1274
        }
        let (inst, dfg) = self.TryCallIndirect(Opcode::TryCallIndirect, ctrl_typevar, ET, vlist); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Vector splat.
    ///
    /// Return a vector whose lanes are all ``x``.
    ///
    /// Inputs:
    ///
    /// - TxN (controlling type variable): A SIMD vector type
    /// - x: Value to splat to all lanes
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn splat(self, TxN: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::Splat, TxN, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Vector swizzle.
    ///
    /// Returns a new vector with byte-width lanes selected from the lanes of the first input
    /// vector ``x`` specified in the second input vector ``s``. The indices ``i`` in range
    /// ``[0, 15]`` select the ``i``-th element of ``x``. For indices outside of the range the
    /// resulting lane is 0. Note that this operates on byte-width lanes.
    ///
    /// Inputs:
    ///
    /// - x: Vector to modify by re-arranging lanes
    /// - y: Mask for re-arranging lanes
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type consisting of 16 lanes of 8-bit integers
    #[allow(non_snake_case, reason = "generated code")]
    fn swizzle(self, x: ir::Value, y: ir::Value) -> Value {
        let (inst, dfg) = self.Binary(Opcode::Swizzle, types::INVALID, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// A vector swizzle lookalike which has the semantics of `pshufb` on x64.
    ///
    /// This instruction will permute the 8-bit lanes of `x` with the indices
    /// specified in `y`. Each lane in the mask, `y`, uses the bottom four
    /// bits for selecting the lane from `x` unless the most significant bit
    /// is set, in which case the lane is zeroed. The output vector will have
    /// the following contents when the element of `y` is in these ranges:
    ///
    /// * `[0, 127]` -> `x[y[i] % 16]`
    /// * `[128, 255]` -> 0
    ///
    /// Inputs:
    ///
    /// - x: Vector to modify by re-arranging lanes
    /// - y: Mask for re-arranging lanes
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type consisting of 16 lanes of 8-bit integers
    #[allow(non_snake_case, reason = "generated code")]
    fn x86_pshufb(self, x: ir::Value, y: ir::Value) -> Value {
        let (inst, dfg) = self.Binary(Opcode::X86Pshufb, types::INVALID, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Insert ``y`` as lane ``Idx`` in x.
    ///
    /// The lane index, ``Idx``, is an immediate value, not an SSA value. It
    /// must indicate a valid lane index for the type of ``x``.
    ///
    /// Inputs:
    ///
    /// - x: The vector to modify
    /// - y: New lane value
    /// - Idx: Lane index
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn insertlane<T1: Into<ir::immediates::Uimm8>>(self, x: ir::Value, y: ir::Value, Idx: T1) -> Value {
        let Idx = Idx.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.TernaryImm8(Opcode::Insertlane, ctrl_typevar, Idx, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Extract lane ``Idx`` from ``x``.
    ///
    /// The lane index, ``Idx``, is an immediate value, not an SSA value. It
    /// must indicate a valid lane index for the type of ``x``. Note that the upper bits of ``a``
    /// may or may not be zeroed depending on the ISA but the type system should prevent using
    /// ``a`` as anything other than the extracted value.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type
    /// - Idx: Lane index
    ///
    /// Outputs:
    ///
    /// - a:
    #[allow(non_snake_case, reason = "generated code")]
    fn extractlane<T1: Into<ir::immediates::Uimm8>>(self, x: ir::Value, Idx: T1) -> Value {
        let Idx = Idx.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm8(Opcode::Extractlane, ctrl_typevar, Idx, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Signed integer minimum.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    /// - y: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn smin(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Smin, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Unsigned integer minimum.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    /// - y: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn umin(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Umin, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Signed integer maximum.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    /// - y: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn smax(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Smax, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Unsigned integer maximum.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    /// - y: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn umax(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Umax, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Unsigned average with rounding: `a := (x + y + 1) // 2`
    ///
    /// The addition does not lose any information (such as from overflow).
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integers
    /// - y: A SIMD vector type containing integers
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type containing integers
    #[allow(non_snake_case, reason = "generated code")]
    fn avg_round(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::AvgRound, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Add with unsigned saturation.
    ///
    /// This is similar to `iadd` but the operands are interpreted as unsigned integers and their
    /// summed result, instead of wrapping, will be saturated to the highest unsigned integer for
    /// the controlling type (e.g. `0xFF` for i8).
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integers
    /// - y: A SIMD vector type containing integers
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type containing integers
    #[allow(non_snake_case, reason = "generated code")]
    fn uadd_sat(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::UaddSat, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Add with signed saturation.
    ///
    /// This is similar to `iadd` but the operands are interpreted as signed integers and their
    /// summed result, instead of wrapping, will be saturated to the lowest or highest
    /// signed integer for the controlling type (e.g. `0x80` or `0x7F` for i8). For example,
    /// since an `sadd_sat.i8` of `0x70` and `0x70` is greater than `0x7F`, the result will be
    /// clamped to `0x7F`.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integers
    /// - y: A SIMD vector type containing integers
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type containing integers
    #[allow(non_snake_case, reason = "generated code")]
    fn sadd_sat(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::SaddSat, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Subtract with unsigned saturation.
    ///
    /// This is similar to `isub` but the operands are interpreted as unsigned integers and their
    /// difference, instead of wrapping, will be saturated to the lowest unsigned integer for
    /// the controlling type (e.g. `0x00` for i8).
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integers
    /// - y: A SIMD vector type containing integers
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type containing integers
    #[allow(non_snake_case, reason = "generated code")]
    fn usub_sat(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::UsubSat, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Subtract with signed saturation.
    ///
    /// This is similar to `isub` but the operands are interpreted as signed integers and their
    /// difference, instead of wrapping, will be saturated to the lowest or highest
    /// signed integer for the controlling type (e.g. `0x80` or `0x7F` for i8).
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integers
    /// - y: A SIMD vector type containing integers
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type containing integers
    #[allow(non_snake_case, reason = "generated code")]
    fn ssub_sat(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::SsubSat, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load from memory at ``p + Offset``.
    ///
    /// This is a polymorphic instruction that can load any value type which
    /// has a memory representation.
    ///
    /// Inputs:
    ///
    /// - Mem (controlling type variable): Any type that can be stored in memory
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn load<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, Mem: crate::ir::Type, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.Load(Opcode::Load, Mem, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Store ``x`` to memory at ``p + Offset``.
    ///
    /// This is a polymorphic instruction that can store any value type with a
    /// memory representation.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - x: Value to be stored
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    #[allow(non_snake_case, reason = "generated code")]
    fn store<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, x: ir::Value, p: ir::Value, Offset: T2) -> Inst {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Store(Opcode::Store, ctrl_typevar, MemFlags, Offset, x, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Load 8 bits from memory at ``p + Offset`` and zero-extend.
    ///
    /// This is equivalent to ``load.i8`` followed by ``uextend``.
    ///
    /// Inputs:
    ///
    /// - iExt8 (controlling type variable): An integer type with more than 8 bits
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: An integer type with more than 8 bits
    #[allow(non_snake_case, reason = "generated code")]
    fn uload8<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, iExt8: crate::ir::Type, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.Load(Opcode::Uload8, iExt8, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load 8 bits from memory at ``p + Offset`` and sign-extend.
    ///
    /// This is equivalent to ``load.i8`` followed by ``sextend``.
    ///
    /// Inputs:
    ///
    /// - iExt8 (controlling type variable): An integer type with more than 8 bits
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: An integer type with more than 8 bits
    #[allow(non_snake_case, reason = "generated code")]
    fn sload8<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, iExt8: crate::ir::Type, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.Load(Opcode::Sload8, iExt8, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Store the low 8 bits of ``x`` to memory at ``p + Offset``.
    ///
    /// This is equivalent to ``ireduce.i8`` followed by ``store.i8``.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - x: An integer type with more than 8 bits
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    #[allow(non_snake_case, reason = "generated code")]
    fn istore8<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, x: ir::Value, p: ir::Value, Offset: T2) -> Inst {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Store(Opcode::Istore8, ctrl_typevar, MemFlags, Offset, x, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Load 16 bits from memory at ``p + Offset`` and zero-extend.
    ///
    /// This is equivalent to ``load.i16`` followed by ``uextend``.
    ///
    /// Inputs:
    ///
    /// - iExt16 (controlling type variable): An integer type with more than 16 bits
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: An integer type with more than 16 bits
    #[allow(non_snake_case, reason = "generated code")]
    fn uload16<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, iExt16: crate::ir::Type, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.Load(Opcode::Uload16, iExt16, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load 16 bits from memory at ``p + Offset`` and sign-extend.
    ///
    /// This is equivalent to ``load.i16`` followed by ``sextend``.
    ///
    /// Inputs:
    ///
    /// - iExt16 (controlling type variable): An integer type with more than 16 bits
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: An integer type with more than 16 bits
    #[allow(non_snake_case, reason = "generated code")]
    fn sload16<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, iExt16: crate::ir::Type, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.Load(Opcode::Sload16, iExt16, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Store the low 16 bits of ``x`` to memory at ``p + Offset``.
    ///
    /// This is equivalent to ``ireduce.i16`` followed by ``store.i16``.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - x: An integer type with more than 16 bits
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    #[allow(non_snake_case, reason = "generated code")]
    fn istore16<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, x: ir::Value, p: ir::Value, Offset: T2) -> Inst {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Store(Opcode::Istore16, ctrl_typevar, MemFlags, Offset, x, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Load 32 bits from memory at ``p + Offset`` and zero-extend.
    ///
    /// This is equivalent to ``load.i32`` followed by ``uextend``.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: An integer type with more than 32 bits
    #[allow(non_snake_case, reason = "generated code")]
    fn uload32<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Load(Opcode::Uload32, ctrl_typevar, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load 32 bits from memory at ``p + Offset`` and sign-extend.
    ///
    /// This is equivalent to ``load.i32`` followed by ``sextend``.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: An integer type with more than 32 bits
    #[allow(non_snake_case, reason = "generated code")]
    fn sload32<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Load(Opcode::Sload32, ctrl_typevar, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Store the low 32 bits of ``x`` to memory at ``p + Offset``.
    ///
    /// This is equivalent to ``ireduce.i32`` followed by ``store.i32``.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - x: An integer type with more than 32 bits
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    #[allow(non_snake_case, reason = "generated code")]
    fn istore32<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, x: ir::Value, p: ir::Value, Offset: T2) -> Inst {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Store(Opcode::Istore32, ctrl_typevar, MemFlags, Offset, x, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Suspends execution of the current stack and resumes execution of another
    /// one.
    ///
    /// The target stack to switch to is identified by the data stored at
    /// ``load_context_ptr``. Before switching, this instruction stores
    /// analogous information about the
    /// current (i.e., original) stack at ``store_context_ptr``, to
    /// enabled switching back to the original stack at a later point.
    ///
    /// The size, alignment and layout of the information stored at
    /// ``load_context_ptr`` and ``store_context_ptr`` is platform-dependent.
    /// The instruction assumes that ``load_context_ptr`` and
    /// ``store_context_ptr`` are valid pointers to memory with said layout and
    /// alignment, and does not perform any checks on these pointers or the data
    /// stored there.
    ///
    /// The instruction is experimental and only supported on x64 Linux at the
    /// moment.
    ///
    /// When switching from a stack A to a stack B, one of the following cases
    /// must apply:
    /// 1. Stack B was previously suspended using a ``stack_switch`` instruction.
    /// 2. Stack B is a newly initialized stack. The necessary initialization is
    /// platform-dependent and will generally involve running some kind of
    /// trampoline to start execution of a function on the new stack.
    ///
    /// In both cases, the ``in_payload`` argument of the ``stack_switch``
    /// instruction executed on A is passed to stack B. In the first case above,
    /// it will be the result value of the earlier ``stack_switch`` instruction
    /// executed on stack B. In the second case, the value will be accessible to
    /// the trampoline in a platform-dependent register.
    ///
    /// The pointers ``load_context_ptr`` and ``store_context_ptr`` are allowed
    /// to be equal; the instruction ensures that all data is loaded from the
    /// former before writing to the latter.
    ///
    /// Stack switching is one-shot in the sense that each ``stack_switch``
    /// operation effectively consumes the context identified by
    /// ``load_context_ptr``. In other words, performing two ``stack_switches``
    /// using the same ``load_context_ptr`` causes undefined behavior, unless
    /// the context at ``load_context_ptr`` is overwritten by another
    /// `stack_switch` in between.
    ///
    /// Inputs:
    ///
    /// - store_context_ptr: An integer address type
    /// - load_context_ptr: An integer address type
    /// - in_payload0: An integer address type
    ///
    /// Outputs:
    ///
    /// - out_payload0: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn stack_switch(self, store_context_ptr: ir::Value, load_context_ptr: ir::Value, in_payload0: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(load_context_ptr); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Ternary(Opcode::StackSwitch, ctrl_typevar, store_context_ptr, load_context_ptr, in_payload0); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load an 8x8 vector (64 bits) from memory at ``p + Offset`` and zero-extend into an i16x8
    /// vector.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn uload8x8<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Load(Opcode::Uload8x8, ctrl_typevar, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load an 8x8 vector (64 bits) from memory at ``p + Offset`` and sign-extend into an i16x8
    /// vector.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn sload8x8<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Load(Opcode::Sload8x8, ctrl_typevar, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load a 16x4 vector (64 bits) from memory at ``p + Offset`` and zero-extend into an i32x4
    /// vector.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn uload16x4<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Load(Opcode::Uload16x4, ctrl_typevar, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load a 16x4 vector (64 bits) from memory at ``p + Offset`` and sign-extend into an i32x4
    /// vector.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn sload16x4<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Load(Opcode::Sload16x4, ctrl_typevar, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load an 32x2 vector (64 bits) from memory at ``p + Offset`` and zero-extend into an i64x2
    /// vector.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn uload32x2<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Load(Opcode::Uload32x2, ctrl_typevar, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load a 32x2 vector (64 bits) from memory at ``p + Offset`` and sign-extend into an i64x2
    /// vector.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - Offset: Byte offset from base address
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn sload32x2<T1: Into<ir::MemFlags>, T2: Into<ir::immediates::Offset32>>(self, MemFlags: T1, p: ir::Value, Offset: T2) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Load(Opcode::Sload32x2, ctrl_typevar, MemFlags, Offset, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load a value from a stack slot at the constant offset.
    ///
    /// This is a polymorphic instruction that can load any value type which
    /// has a memory representation.
    ///
    /// The offset is an immediate constant, not an SSA value. The memory
    /// access cannot go out of bounds, i.e.
    /// `sizeof(a) + Offset <= sizeof(SS)`.
    ///
    /// Inputs:
    ///
    /// - Mem (controlling type variable): Any type that can be stored in memory
    /// - SS: A stack slot
    /// - Offset: In-bounds offset into stack slot
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn stack_load<T1: Into<ir::immediates::Offset32>>(self, Mem: crate::ir::Type, SS: ir::StackSlot, Offset: T1) -> Value {
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.StackLoad(Opcode::StackLoad, Mem, SS, Offset); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Store a value to a stack slot at a constant offset.
    ///
    /// This is a polymorphic instruction that can store any value type with a
    /// memory representation.
    ///
    /// The offset is an immediate constant, not an SSA value. The memory
    /// access cannot go out of bounds, i.e.
    /// `sizeof(a) + Offset <= sizeof(SS)`.
    ///
    /// Inputs:
    ///
    /// - x: Value to be stored
    /// - SS: A stack slot
    /// - Offset: In-bounds offset into stack slot
    #[allow(non_snake_case, reason = "generated code")]
    fn stack_store<T1: Into<ir::immediates::Offset32>>(self, x: ir::Value, SS: ir::StackSlot, Offset: T1) -> Inst {
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.StackStore(Opcode::StackStore, ctrl_typevar, SS, Offset, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Get the address of a stack slot.
    ///
    /// Compute the absolute address of a byte in a stack slot. The offset must
    /// refer to a byte inside the stack slot:
    /// `0 <= Offset < sizeof(SS)`.
    ///
    /// Inputs:
    ///
    /// - iAddr (controlling type variable): An integer address type
    /// - SS: A stack slot
    /// - Offset: In-bounds offset into stack slot
    ///
    /// Outputs:
    ///
    /// - addr: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn stack_addr<T1: Into<ir::immediates::Offset32>>(self, iAddr: crate::ir::Type, SS: ir::StackSlot, Offset: T1) -> Value {
        let Offset = Offset.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.StackLoad(Opcode::StackAddr, iAddr, SS, Offset); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Load a value from a dynamic stack slot.
    ///
    /// This is a polymorphic instruction that can load any value type which
    /// has a memory representation.
    ///
    /// Inputs:
    ///
    /// - Mem (controlling type variable): Any type that can be stored in memory
    /// - DSS: A dynamic stack slot
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn dynamic_stack_load(self, Mem: crate::ir::Type, DSS: ir::DynamicStackSlot) -> Value {
        let (inst, dfg) = self.DynamicStackLoad(Opcode::DynamicStackLoad, Mem, DSS); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Store a value to a dynamic stack slot.
    ///
    /// This is a polymorphic instruction that can store any dynamic value type with a
    /// memory representation.
    ///
    /// Inputs:
    ///
    /// - x: Value to be stored
    /// - DSS: A dynamic stack slot
    #[allow(non_snake_case, reason = "generated code")]
    fn dynamic_stack_store(self, x: ir::Value, DSS: ir::DynamicStackSlot) -> Inst {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.DynamicStackStore(Opcode::DynamicStackStore, ctrl_typevar, DSS, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Get the address of a dynamic stack slot.
    ///
    /// Compute the absolute address of the first byte of a dynamic stack slot.
    ///
    /// Inputs:
    ///
    /// - iAddr (controlling type variable): An integer address type
    /// - DSS: A dynamic stack slot
    ///
    /// Outputs:
    ///
    /// - addr: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn dynamic_stack_addr(self, iAddr: crate::ir::Type, DSS: ir::DynamicStackSlot) -> Value {
        let (inst, dfg) = self.DynamicStackLoad(Opcode::DynamicStackAddr, iAddr, DSS); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Compute the value of global GV.
    ///
    /// Inputs:
    ///
    /// - Mem (controlling type variable): Any type that can be stored in memory
    /// - GV: A global value.
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn global_value(self, Mem: crate::ir::Type, GV: ir::GlobalValue) -> Value {
        let (inst, dfg) = self.UnaryGlobalValue(Opcode::GlobalValue, Mem, GV); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Compute the value of global GV, which is a symbolic value.
    ///
    /// Inputs:
    ///
    /// - Mem (controlling type variable): Any type that can be stored in memory
    /// - GV: A global value.
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn symbol_value(self, Mem: crate::ir::Type, GV: ir::GlobalValue) -> Value {
        let (inst, dfg) = self.UnaryGlobalValue(Opcode::SymbolValue, Mem, GV); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Compute the value of global GV, which is a TLS (thread local storage) value.
    ///
    /// Inputs:
    ///
    /// - Mem (controlling type variable): Any type that can be stored in memory
    /// - GV: A global value.
    ///
    /// Outputs:
    ///
    /// - a: Value loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn tls_value(self, Mem: crate::ir::Type, GV: ir::GlobalValue) -> Value {
        let (inst, dfg) = self.UnaryGlobalValue(Opcode::TlsValue, Mem, GV); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Gets the content of the pinned register, when it's enabled.
    ///
    /// Inputs:
    ///
    /// - iAddr (controlling type variable): An integer address type
    ///
    /// Outputs:
    ///
    /// - addr: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn get_pinned_reg(self, iAddr: crate::ir::Type) -> Value {
        let (inst, dfg) = self.NullAry(Opcode::GetPinnedReg, iAddr); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Sets the content of the pinned register, when it's enabled.
    ///
    /// Inputs:
    ///
    /// - addr: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn set_pinned_reg(self, addr: ir::Value) -> Inst {
        let ctrl_typevar = self.data_flow_graph().value_type(addr); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::SetPinnedReg, ctrl_typevar, addr); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Get the address in the frame pointer register.
    ///
    /// Usage of this instruction requires setting `preserve_frame_pointers` to `true`.
    ///
    /// Inputs:
    ///
    /// - iAddr (controlling type variable): An integer address type
    ///
    /// Outputs:
    ///
    /// - addr: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn get_frame_pointer(self, iAddr: crate::ir::Type) -> Value {
        let (inst, dfg) = self.NullAry(Opcode::GetFramePointer, iAddr); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Get the address in the stack pointer register.
    ///
    /// Inputs:
    ///
    /// - iAddr (controlling type variable): An integer address type
    ///
    /// Outputs:
    ///
    /// - addr: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn get_stack_pointer(self, iAddr: crate::ir::Type) -> Value {
        let (inst, dfg) = self.NullAry(Opcode::GetStackPointer, iAddr); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Get the PC where this function will transfer control to when it returns.
    ///
    /// Usage of this instruction requires setting `preserve_frame_pointers` to `true`.
    ///
    /// Inputs:
    ///
    /// - iAddr (controlling type variable): An integer address type
    ///
    /// Outputs:
    ///
    /// - addr: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn get_return_address(self, iAddr: crate::ir::Type) -> Value {
        let (inst, dfg) = self.NullAry(Opcode::GetReturnAddress, iAddr); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Get the handler PC for the given exceptional edge for an
    /// exception return from the given `try_call`-terminated block.
    ///
    /// This instruction provides the PC for the handler resume point,
    /// as defined by the exception-handling aspect of the given
    /// callee ABI, for a return from the given calling block.  It can
    /// be used when the exception unwind mechanism requires manual
    /// plumbing for this information which must be set up before the call
    /// itself: for example, if the resume address needs to be stored in
    /// some context structure for a runtime to resume to on error.
    ///
    /// The given caller block must end in a `try_call` and the given
    /// exception-handling block must be one of its exceptional
    /// successors in the associated exception-handling table. The
    /// returned PC is *only* valid to resume to when the `try_call`
    /// is on the stack having called the callee; in other words, when
    /// a normal exception unwinder might otherwise resume to that
    /// handler.
    ///
    /// Inputs:
    ///
    /// - iAddr (controlling type variable): An integer address type
    /// - block: raw basic block
    /// - index: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - addr: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn get_exception_handler_address<T1: Into<ir::immediates::Imm64>>(self, iAddr: crate::ir::Type, block: ir::Block, index: T1) -> Value {
        let index = index.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.ExceptionHandlerAddress(Opcode::GetExceptionHandlerAddress, iAddr, block, index); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Integer constant.
    ///
    /// Create a scalar integer SSA value with an immediate constant value, or
    /// an integer vector where all the lanes have the same value.
    ///
    /// Inputs:
    ///
    /// - NarrowInt (controlling type variable): An integer type of width up to `i64`
    /// - N: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A constant integer scalar or vector value
    #[allow(non_snake_case, reason = "generated code")]
    fn iconst<T1: Into<ir::immediates::Imm64>>(self, NarrowInt: crate::ir::Type, N: T1) -> Value {
        let N = N.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.UnaryImm(Opcode::Iconst, NarrowInt, N); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point constant.
    ///
    /// Create a `f16` SSA value with an immediate constant value.
    ///
    /// Inputs:
    ///
    /// - N: A 16-bit immediate floating point number.
    ///
    /// Outputs:
    ///
    /// - a: A constant f16 scalar value
    #[allow(non_snake_case, reason = "generated code")]
    fn f16const<T1: Into<ir::immediates::Ieee16>>(self, N: T1) -> Value {
        let N = N.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.UnaryIeee16(Opcode::F16const, types::INVALID, N); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point constant.
    ///
    /// Create a `f32` SSA value with an immediate constant value.
    ///
    /// Inputs:
    ///
    /// - N: A 32-bit immediate floating point number.
    ///
    /// Outputs:
    ///
    /// - a: A constant f32 scalar value
    #[allow(non_snake_case, reason = "generated code")]
    fn f32const<T1: Into<ir::immediates::Ieee32>>(self, N: T1) -> Value {
        let N = N.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.UnaryIeee32(Opcode::F32const, types::INVALID, N); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point constant.
    ///
    /// Create a `f64` SSA value with an immediate constant value.
    ///
    /// Inputs:
    ///
    /// - N: A 64-bit immediate floating point number.
    ///
    /// Outputs:
    ///
    /// - a: A constant f64 scalar value
    #[allow(non_snake_case, reason = "generated code")]
    fn f64const<T1: Into<ir::immediates::Ieee64>>(self, N: T1) -> Value {
        let N = N.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.UnaryIeee64(Opcode::F64const, types::INVALID, N); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point constant.
    ///
    /// Create a `f128` SSA value with an immediate constant value.
    ///
    /// Inputs:
    ///
    /// - N: A constant stored in the constant pool.
    ///
    /// Outputs:
    ///
    /// - a: A constant f128 scalar value
    #[allow(non_snake_case, reason = "generated code")]
    fn f128const(self, N: ir::Constant) -> Value {
        let (inst, dfg) = self.UnaryConst(Opcode::F128const, types::INVALID, N); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// SIMD vector constant.
    ///
    /// Construct a vector with the given immediate bytes.
    ///
    /// Inputs:
    ///
    /// - TxN (controlling type variable): A SIMD vector type
    /// - N: The 16 immediate bytes of a 128-bit vector
    ///
    /// Outputs:
    ///
    /// - a: A constant vector value
    #[allow(non_snake_case, reason = "generated code")]
    fn vconst(self, TxN: crate::ir::Type, N: ir::Constant) -> Value {
        let (inst, dfg) = self.UnaryConst(Opcode::Vconst, TxN, N); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// SIMD vector shuffle.
    ///
    /// Shuffle two vectors using the given immediate bytes. For each of the 16 bytes of the
    /// immediate, a value i of 0-15 selects the i-th element of the first vector and a value i of
    /// 16-31 selects the (i-16)th element of the second vector. Immediate values outside of the
    /// 0-31 range are not valid.
    ///
    /// Inputs:
    ///
    /// - a: A vector value
    /// - b: A vector value
    /// - mask: The 16 immediate bytes used for selecting the elements to shuffle
    ///
    /// Outputs:
    ///
    /// - a: A vector value
    #[allow(non_snake_case, reason = "generated code")]
    fn shuffle(self, a: ir::Value, b: ir::Value, mask: ir::Immediate) -> Value {
        let (inst, dfg) = self.Shuffle(Opcode::Shuffle, types::INVALID, mask, a, b); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Just a dummy instruction.
    ///
    /// Note: this doesn't compile to a machine code nop.
    #[allow(non_snake_case, reason = "generated code")]
    fn nop(self) -> Inst {
        let (inst, dfg) = self.NullAry(Opcode::Nop, types::INVALID); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Conditional select.
    ///
    /// This instruction selects whole values. Use `bitselect` to choose each
    /// bit according to a mask.
    ///
    /// Inputs:
    ///
    /// - c: Controlling value to test
    /// - x: Value to use when `c` is true
    /// - y: Value to use when `c` is false
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or reference scalar or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn select(self, c: ir::Value, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Ternary(Opcode::Select, ctrl_typevar, c, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Conditional select intended for Spectre guards.
    ///
    /// This operation is semantically equivalent to a select instruction.
    /// However, this instruction prohibits all speculation on the
    /// controlling value when determining which input to use as the result.
    /// As such, it is suitable for use in Spectre guards.
    ///
    /// For example, on a target which may speculatively execute branches,
    /// the lowering of this instruction is guaranteed to not conditionally
    /// branch. Instead it will typically lower to a conditional move
    /// instruction. (No Spectre-vulnerable processors are known to perform
    /// value speculation on conditional move instructions.)
    ///
    /// Ensure that the instruction you're trying to protect from Spectre
    /// attacks has a data dependency on the result of this instruction.
    /// That prevents an out-of-order CPU from evaluating that instruction
    /// until the result of this one is known, which in turn will be blocked
    /// until the controlling value is known.
    ///
    /// Typical usage is to use a bounds-check as the controlling value,
    /// and select between either a null pointer if the bounds-check
    /// fails, or an in-bounds address otherwise, so that dereferencing
    /// the resulting address with a load or store instruction will trap if
    /// the bounds-check failed. When this instruction is used in this way,
    /// any microarchitectural side effects of the memory access will only
    /// occur after the bounds-check finishes, which ensures that no Spectre
    /// vulnerability will exist.
    ///
    /// Optimization opportunities for this instruction are limited compared
    /// to a normal select instruction, but it is allowed to be replaced
    /// by other values which are functionally equivalent as long as doing
    /// so does not introduce any new opportunities to speculate on the
    /// controlling value.
    ///
    /// Inputs:
    ///
    /// - c: Controlling value to test
    /// - x: Value to use when `c` is true
    /// - y: Value to use when `c` is false
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or reference scalar or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn select_spectre_guard(self, c: ir::Value, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Ternary(Opcode::SelectSpectreGuard, ctrl_typevar, c, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Conditional select of bits.
    ///
    /// For each bit in `c`, this instruction selects the corresponding bit from `x` if the bit
    /// in `c` is 1 and the corresponding bit from `y` if the bit in `c` is 0. See also:
    /// `select`.
    ///
    /// Inputs:
    ///
    /// - c: Controlling value to test
    /// - x: Value to use when `c` is true
    /// - y: Value to use when `c` is false
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or reference scalar or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn bitselect(self, c: ir::Value, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Ternary(Opcode::Bitselect, ctrl_typevar, c, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// A bitselect-lookalike instruction except with the semantics of
    /// `blendv`-related instructions on x86.
    ///
    /// This instruction will use the top bit of each lane in `c`, the condition
    /// mask. If the bit is 1 then the corresponding lane from `x` is chosen.
    /// Otherwise the corresponding lane from `y` is chosen.
    ///
    /// Inputs:
    ///
    /// - c: Controlling value to test
    /// - x: Value to use when `c` is true
    /// - y: Value to use when `c` is false
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or reference scalar or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn blendv(self, c: ir::Value, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Ternary(Opcode::Blendv, ctrl_typevar, c, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Reduce a vector to a scalar boolean.
    ///
    /// Return a scalar boolean true if any lane in ``a`` is non-zero, false otherwise.
    ///
    /// Inputs:
    ///
    /// - a: A SIMD vector type
    ///
    /// Outputs:
    ///
    /// - s: An integer type with 8 bits.
    /// WARNING: arithmetic on 8bit integers is incomplete
    #[allow(non_snake_case, reason = "generated code")]
    fn vany_true(self, a: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(a); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::VanyTrue, ctrl_typevar, a); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Reduce a vector to a scalar boolean.
    ///
    /// Return a scalar boolean true if all lanes in ``i`` are non-zero, false otherwise.
    ///
    /// Inputs:
    ///
    /// - a: A SIMD vector type
    ///
    /// Outputs:
    ///
    /// - s: An integer type with 8 bits.
    /// WARNING: arithmetic on 8bit integers is incomplete
    #[allow(non_snake_case, reason = "generated code")]
    fn vall_true(self, a: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(a); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::VallTrue, ctrl_typevar, a); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Reduce a vector to a scalar integer.
    ///
    /// Return a scalar integer, consisting of the concatenation of the most significant bit
    /// of each lane of ``a``.
    ///
    /// Inputs:
    ///
    /// - NarrowInt (controlling type variable): An integer type of width up to `i64`
    /// - a: A SIMD vector type
    ///
    /// Outputs:
    ///
    /// - x: An integer type of width up to `i64`
    #[allow(non_snake_case, reason = "generated code")]
    fn vhigh_bits(self, NarrowInt: crate::ir::Type, a: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::VhighBits, NarrowInt, a); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Integer comparison.
    ///
    /// The condition code determines if the operands are interpreted as signed
    /// or unsigned integers.
    ///
    /// | Signed | Unsigned | Condition             |
    /// |--------|----------|-----------------------|
    /// | eq     | eq       | Equal                 |
    /// | ne     | ne       | Not equal             |
    /// | slt    | ult      | Less than             |
    /// | sge    | uge      | Greater than or equal |
    /// | sgt    | ugt      | Greater than          |
    /// | sle    | ule      | Less than or equal    |
    ///
    /// When this instruction compares integer vectors, it returns a vector of
    /// lane-wise comparisons.
    ///
    /// When comparing scalars, the result is:
    ///     - `1` if the condition holds.
    ///     - `0` if the condition does not hold.
    ///
    /// When comparing vectors, the result is:
    ///     - `-1` (i.e. all ones) in each lane where the condition holds.
    ///     - `0` in each lane where the condition does not hold.
    ///
    /// Inputs:
    ///
    /// - Cond: An integer comparison condition code.
    /// - x: A scalar or vector integer type
    /// - y: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a:
    #[allow(non_snake_case, reason = "generated code")]
    fn icmp<T1: Into<ir::condcodes::IntCC>>(self, Cond: T1, x: ir::Value, y: ir::Value) -> Value {
        let Cond = Cond.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.IntCompare(Opcode::Icmp, ctrl_typevar, Cond, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Compare scalar integer to a constant.
    ///
    /// This is the same as the `icmp` instruction, except one operand is
    /// a sign extended 64 bit immediate constant.
    ///
    /// This instruction can only compare scalars. Use `icmp` for
    /// lane-wise vector comparisons.
    ///
    /// Inputs:
    ///
    /// - Cond: An integer comparison condition code.
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: An integer type with 8 bits.
    /// WARNING: arithmetic on 8bit integers is incomplete
    #[allow(non_snake_case, reason = "generated code")]
    fn icmp_imm<T1: Into<ir::condcodes::IntCC>, T2: Into<ir::immediates::Imm64>>(self, Cond: T1, x: ir::Value, Y: T2) -> Value {
        let Cond = Cond.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.IntCompareImm(Opcode::IcmpImm, ctrl_typevar, Cond, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Wrapping integer addition: `a := x + y \pmod{2^B}`.
    ///
    /// This instruction does not depend on the signed/unsigned interpretation
    /// of the operands.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    /// - y: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn iadd(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Iadd, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Wrapping integer subtraction: `a := x - y \pmod{2^B}`.
    ///
    /// This instruction does not depend on the signed/unsigned interpretation
    /// of the operands.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    /// - y: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn isub(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Isub, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Integer negation: `a := -x \pmod{2^B}`.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn ineg(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Ineg, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Integer absolute value with wrapping: `a := |x|`.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn iabs(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Iabs, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Wrapping integer multiplication: `a := x y \pmod{2^B}`.
    ///
    /// This instruction does not depend on the signed/unsigned interpretation
    /// of the operands.
    ///
    /// Polymorphic over all integer types (vector and scalar).
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    /// - y: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn imul(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Imul, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Unsigned integer multiplication, producing the high half of a
    /// double-length result.
    ///
    /// Polymorphic over all integer types (vector and scalar).
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    /// - y: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn umulhi(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Umulhi, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Signed integer multiplication, producing the high half of a
    /// double-length result.
    ///
    /// Polymorphic over all integer types (vector and scalar).
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    /// - y: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn smulhi(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Smulhi, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Fixed-point multiplication of numbers in the QN format, where N + 1
    /// is the number bitwidth:
    /// `a := signed_saturate((x * y + (1 << (Q - 1))) >> Q)`
    ///
    /// Polymorphic over all integer vector types with 16- or 32-bit numbers.
    ///
    /// Inputs:
    ///
    /// - x: A vector integer type with 16- or 32-bit numbers
    /// - y: A vector integer type with 16- or 32-bit numbers
    ///
    /// Outputs:
    ///
    /// - a: A vector integer type with 16- or 32-bit numbers
    #[allow(non_snake_case, reason = "generated code")]
    fn sqmul_round_sat(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::SqmulRoundSat, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// A similar instruction to `sqmul_round_sat` except with the semantics
    /// of x86's `pmulhrsw` instruction.
    ///
    /// This is the same as `sqmul_round_sat` except when both input lanes are
    /// `i16::MIN`.
    ///
    /// Inputs:
    ///
    /// - x: A vector integer type with 16- or 32-bit numbers
    /// - y: A vector integer type with 16- or 32-bit numbers
    ///
    /// Outputs:
    ///
    /// - a: A vector integer type with 16- or 32-bit numbers
    #[allow(non_snake_case, reason = "generated code")]
    fn x86_pmulhrsw(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::X86Pmulhrsw, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Unsigned integer division: `a := \lfloor {x \over y} \rfloor`.
    ///
    /// This operation traps if the divisor is zero.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn udiv(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Udiv, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Signed integer division rounded toward zero: `a := sign(xy)
    /// \lfloor {|x| \over |y|}\rfloor`.
    ///
    /// This operation traps if the divisor is zero, or if the result is not
    /// representable in `B` bits two's complement. This only happens
    /// when `x = -2^{B-1}, y = -1`.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn sdiv(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Sdiv, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Unsigned integer remainder.
    ///
    /// This operation traps if the divisor is zero.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn urem(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Urem, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Signed integer remainder. The result has the sign of the dividend.
    ///
    /// This operation traps if the divisor is zero.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn srem(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Srem, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Add immediate integer.
    ///
    /// Same as `iadd`, but one operand is a sign extended 64 bit immediate constant.
    ///
    /// Polymorphic over all scalar integer types, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn iadd_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::IaddImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Integer multiplication by immediate constant.
    ///
    /// Same as `imul`, but one operand is a sign extended 64 bit immediate constant.
    ///
    /// Polymorphic over all scalar integer types, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn imul_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::ImulImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Unsigned integer division by an immediate constant.
    ///
    /// Same as `udiv`, but one operand is a zero extended 64 bit immediate constant.
    ///
    /// This operation traps if the divisor is zero.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn udiv_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::UdivImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Signed integer division by an immediate constant.
    ///
    /// Same as `sdiv`, but one operand is a sign extended 64 bit immediate constant.
    ///
    /// This operation traps if the divisor is zero, or if the result is not
    /// representable in `B` bits two's complement. This only happens
    /// when `x = -2^{B-1}, Y = -1`.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn sdiv_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::SdivImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Unsigned integer remainder with immediate divisor.
    ///
    /// Same as `urem`, but one operand is a zero extended 64 bit immediate constant.
    ///
    /// This operation traps if the divisor is zero.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn urem_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::UremImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Signed integer remainder with immediate divisor.
    ///
    /// Same as `srem`, but one operand is a sign extended 64 bit immediate constant.
    ///
    /// This operation traps if the divisor is zero.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn srem_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::SremImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Immediate reverse wrapping subtraction: `a := Y - x \pmod{2^B}`.
    ///
    /// The immediate operand is a sign extended 64 bit constant.
    ///
    /// Also works as integer negation when `Y = 0`. Use `iadd_imm`
    /// with a negative immediate operand for the reverse immediate
    /// subtraction.
    ///
    /// Polymorphic over all scalar integer types, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn irsub_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::IrsubImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Add signed integers with carry in and overflow out.
    ///
    /// Same as `sadd_overflow` with an additional carry input. The `c_in` type
    /// is interpreted as 1 if it's nonzero or 0 if it's zero.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    /// - c_in: Input carry flag
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    /// - c_out: Output carry flag
    #[allow(non_snake_case, reason = "generated code")]
    fn sadd_overflow_cin(self, x: ir::Value, y: ir::Value, c_in: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Ternary(Opcode::SaddOverflowCin, ctrl_typevar, x, y, c_in); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Add unsigned integers with carry in and overflow out.
    ///
    /// Same as `uadd_overflow` with an additional carry input. The `c_in` type
    /// is interpreted as 1 if it's nonzero or 0 if it's zero.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    /// - c_in: Input carry flag
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    /// - c_out: Output carry flag
    #[allow(non_snake_case, reason = "generated code")]
    fn uadd_overflow_cin(self, x: ir::Value, y: ir::Value, c_in: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Ternary(Opcode::UaddOverflowCin, ctrl_typevar, x, y, c_in); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Add integers unsigned with overflow out.
    /// ``of`` is set when the addition overflowed.
    /// ```text
    ///     a &= x + y \pmod 2^B \\
    ///     of &= x+y >= 2^B
    /// ```
    /// Polymorphic over all scalar integer types, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    /// - of: Overflow flag
    #[allow(non_snake_case, reason = "generated code")]
    fn uadd_overflow(self, x: ir::Value, y: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::UaddOverflow, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Add integers signed with overflow out.
    /// ``of`` is set when the addition over- or underflowed.
    /// Polymorphic over all scalar integer types, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    /// - of: Overflow flag
    #[allow(non_snake_case, reason = "generated code")]
    fn sadd_overflow(self, x: ir::Value, y: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::SaddOverflow, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Subtract integers unsigned with overflow out.
    /// ``of`` is set when the subtraction underflowed.
    /// ```text
    ///     a &= x - y \pmod 2^B \\
    ///     of &= x - y < 0
    /// ```
    /// Polymorphic over all scalar integer types, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    /// - of: Overflow flag
    #[allow(non_snake_case, reason = "generated code")]
    fn usub_overflow(self, x: ir::Value, y: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::UsubOverflow, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Subtract integers signed with overflow out.
    /// ``of`` is set when the subtraction over- or underflowed.
    /// Polymorphic over all scalar integer types, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    /// - of: Overflow flag
    #[allow(non_snake_case, reason = "generated code")]
    fn ssub_overflow(self, x: ir::Value, y: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::SsubOverflow, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Multiply integers unsigned with overflow out.
    /// ``of`` is set when the multiplication overflowed.
    /// ```text
    ///     a &= x * y \pmod 2^B \\
    ///     of &= x * y > 2^B
    /// ```
    /// Polymorphic over all scalar integer types except i128, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type up to 64 bits
    /// - y: A scalar integer type up to 64 bits
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type up to 64 bits
    /// - of: Overflow flag
    #[allow(non_snake_case, reason = "generated code")]
    fn umul_overflow(self, x: ir::Value, y: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::UmulOverflow, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Multiply integers signed with overflow out.
    /// ``of`` is set when the multiplication over- or underflowed.
    /// Polymorphic over all scalar integer types except i128, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type up to 64 bits
    /// - y: A scalar integer type up to 64 bits
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type up to 64 bits
    /// - of: Overflow flag
    #[allow(non_snake_case, reason = "generated code")]
    fn smul_overflow(self, x: ir::Value, y: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::SmulOverflow, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Unsigned addition of x and y, trapping if the result overflows.
    ///
    /// Accepts 32 or 64-bit integers, and does not support vector types.
    ///
    /// Inputs:
    ///
    /// - x: A 32 or 64-bit scalar integer type
    /// - y: A 32 or 64-bit scalar integer type
    /// - code: A trap reason code.
    ///
    /// Outputs:
    ///
    /// - a: A 32 or 64-bit scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn uadd_overflow_trap<T1: Into<ir::TrapCode>>(self, x: ir::Value, y: ir::Value, code: T1) -> Value {
        let code = code.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.IntAddTrap(Opcode::UaddOverflowTrap, ctrl_typevar, code, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Subtract signed integers with borrow in and overflow out.
    ///
    /// Same as `ssub_overflow` with an additional borrow input. The `b_in` type
    /// is interpreted as 1 if it's nonzero or 0 if it's zero. The computation
    /// performed here is `x - (y + (b_in != 0))`.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    /// - b_in: Input borrow flag
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    /// - b_out: Output borrow flag
    #[allow(non_snake_case, reason = "generated code")]
    fn ssub_overflow_bin(self, x: ir::Value, y: ir::Value, b_in: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Ternary(Opcode::SsubOverflowBin, ctrl_typevar, x, y, b_in); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Subtract unsigned integers with borrow in and overflow out.
    ///
    /// Same as `usub_overflow` with an additional borrow input. The `b_in` type
    /// is interpreted as 1 if it's nonzero or 0 if it's zero. The computation
    /// performed here is `x - (y + (b_in != 0))`.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - y: A scalar integer type
    /// - b_in: Input borrow flag
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    /// - b_out: Output borrow flag
    #[allow(non_snake_case, reason = "generated code")]
    fn usub_overflow_bin(self, x: ir::Value, y: ir::Value, b_in: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Ternary(Opcode::UsubOverflowBin, ctrl_typevar, x, y, b_in); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Bitwise and.
    ///
    /// Inputs:
    ///
    /// - x: Any integer, float, or vector type
    /// - y: Any integer, float, or vector type
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn band(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Band, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Bitwise or.
    ///
    /// Inputs:
    ///
    /// - x: Any integer, float, or vector type
    /// - y: Any integer, float, or vector type
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn bor(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Bor, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Bitwise xor.
    ///
    /// Inputs:
    ///
    /// - x: Any integer, float, or vector type
    /// - y: Any integer, float, or vector type
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn bxor(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Bxor, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Bitwise not.
    ///
    /// Inputs:
    ///
    /// - x: Any integer, float, or vector type
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn bnot(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Bnot, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Bitwise and not.
    ///
    /// Computes `x & ~y`.
    ///
    /// Inputs:
    ///
    /// - x: Any integer, float, or vector type
    /// - y: Any integer, float, or vector type
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn band_not(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::BandNot, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Bitwise or not.
    ///
    /// Computes `x | ~y`.
    ///
    /// Inputs:
    ///
    /// - x: Any integer, float, or vector type
    /// - y: Any integer, float, or vector type
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn bor_not(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::BorNot, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Bitwise xor not.
    ///
    /// Computes `x ^ ~y`.
    ///
    /// Inputs:
    ///
    /// - x: Any integer, float, or vector type
    /// - y: Any integer, float, or vector type
    ///
    /// Outputs:
    ///
    /// - a: Any integer, float, or vector type
    #[allow(non_snake_case, reason = "generated code")]
    fn bxor_not(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::BxorNot, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Bitwise and with immediate.
    ///
    /// Same as `band`, but one operand is a zero extended 64 bit immediate constant.
    ///
    /// Polymorphic over all scalar integer types, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn band_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::BandImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Bitwise or with immediate.
    ///
    /// Same as `bor`, but one operand is a zero extended 64 bit immediate constant.
    ///
    /// Polymorphic over all scalar integer types, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn bor_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::BorImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Bitwise xor with immediate.
    ///
    /// Same as `bxor`, but one operand is a zero extended 64 bit immediate constant.
    ///
    /// Polymorphic over all scalar integer types, but does not support vector
    /// types.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn bxor_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::BxorImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Rotate left.
    ///
    /// Rotate the bits in ``x`` by ``y`` places.
    ///
    /// Inputs:
    ///
    /// - x: Scalar or vector value to shift
    /// - y: Number of bits to shift
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn rotl(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Rotl, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Rotate right.
    ///
    /// Rotate the bits in ``x`` by ``y`` places.
    ///
    /// Inputs:
    ///
    /// - x: Scalar or vector value to shift
    /// - y: Number of bits to shift
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn rotr(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Rotr, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Rotate left by immediate.
    ///
    /// Same as `rotl`, but one operand is a zero extended 64 bit immediate constant.
    ///
    /// Inputs:
    ///
    /// - x: Scalar or vector value to shift
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn rotl_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::RotlImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Rotate right by immediate.
    ///
    /// Same as `rotr`, but one operand is a zero extended 64 bit immediate constant.
    ///
    /// Inputs:
    ///
    /// - x: Scalar or vector value to shift
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn rotr_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::RotrImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Integer shift left. Shift the bits in ``x`` towards the MSB by ``y``
    /// places. Shift in zero bits to the LSB.
    ///
    /// The shift amount is masked to the size of ``x``.
    ///
    /// When shifting a B-bits integer type, this instruction computes:
    ///
    /// ```text
    ///     s &:= y \pmod B,
    ///     a &:= x \cdot 2^s \pmod{2^B}.
    /// ```
    ///
    /// Inputs:
    ///
    /// - x: Scalar or vector value to shift
    /// - y: Number of bits to shift
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn ishl(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Ishl, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Unsigned shift right. Shift bits in ``x`` towards the LSB by ``y``
    /// places, shifting in zero bits to the MSB. Also called a *logical
    /// shift*.
    ///
    /// The shift amount is masked to the size of ``x``.
    ///
    /// When shifting a B-bits integer type, this instruction computes:
    ///
    /// ```text
    ///     s &:= y \pmod B,
    ///     a &:= \lfloor x \cdot 2^{-s} \rfloor.
    /// ```
    ///
    /// Inputs:
    ///
    /// - x: Scalar or vector value to shift
    /// - y: Number of bits to shift
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn ushr(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Ushr, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Signed shift right. Shift bits in ``x`` towards the LSB by ``y``
    /// places, shifting in sign bits to the MSB. Also called an *arithmetic
    /// shift*.
    ///
    /// The shift amount is masked to the size of ``x``.
    ///
    /// Inputs:
    ///
    /// - x: Scalar or vector value to shift
    /// - y: Number of bits to shift
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn sshr(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Sshr, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Integer shift left by immediate.
    ///
    /// The shift amount is masked to the size of ``x``.
    ///
    /// Inputs:
    ///
    /// - x: Scalar or vector value to shift
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn ishl_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::IshlImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Unsigned shift right by immediate.
    ///
    /// The shift amount is masked to the size of ``x``.
    ///
    /// Inputs:
    ///
    /// - x: Scalar or vector value to shift
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn ushr_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::UshrImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Signed shift right by immediate.
    ///
    /// The shift amount is masked to the size of ``x``.
    ///
    /// Inputs:
    ///
    /// - x: Scalar or vector value to shift
    /// - Y: A 64-bit immediate integer.
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn sshr_imm<T1: Into<ir::immediates::Imm64>>(self, x: ir::Value, Y: T1) -> Value {
        let Y = Y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm64(Opcode::SshrImm, ctrl_typevar, Y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Reverse the bits of a integer.
    ///
    /// Reverses the bits in ``x``.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn bitrev(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Bitrev, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Count leading zero bits.
    ///
    /// Starting from the MSB in ``x``, count the number of zero bits before
    /// reaching the first one bit. When ``x`` is zero, returns the size of x
    /// in bits.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn clz(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Clz, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Count leading sign bits.
    ///
    /// Starting from the MSB after the sign bit in ``x``, count the number of
    /// consecutive bits identical to the sign bit. When ``x`` is 0 or -1,
    /// returns one less than the size of x in bits.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn cls(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Cls, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Count trailing zeros.
    ///
    /// Starting from the LSB in ``x``, count the number of zero bits before
    /// reaching the first one bit. When ``x`` is zero, returns the size of x
    /// in bits.
    ///
    /// Inputs:
    ///
    /// - x: A scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn ctz(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Ctz, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Reverse the byte order of an integer.
    ///
    /// Reverses the bytes in ``x``.
    ///
    /// Inputs:
    ///
    /// - x: A multi byte scalar integer type
    ///
    /// Outputs:
    ///
    /// - a: A multi byte scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn bswap(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Bswap, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Population count
    ///
    /// Count the number of one bits in ``x``.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn popcnt(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Popcnt, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point comparison.
    ///
    /// Two IEEE 754-2008 floating point numbers, `x` and `y`, relate to each
    /// other in exactly one of four ways:
    ///
    /// ```text
    /// == ==========================================
    /// UN Unordered when one or both numbers is NaN.
    /// EQ When `x = y`. (And `0.0 = -0.0`).
    /// LT When `x < y`.
    /// GT When `x > y`.
    /// == ==========================================
    /// ```
    ///
    /// The 14 `floatcc` condition codes each correspond to a subset of
    /// the four relations, except for the empty set which would always be
    /// false, and the full set which would always be true.
    ///
    /// The condition codes are divided into 7 'ordered' conditions which don't
    /// include UN, and 7 unordered conditions which all include UN.
    ///
    /// ```text
    /// +-------+------------+---------+------------+-------------------------+
    /// |Ordered             |Unordered             |Condition                |
    /// +=======+============+=========+============+=========================+
    /// |ord    |EQ | LT | GT|uno      |UN          |NaNs absent / present.   |
    /// +-------+------------+---------+------------+-------------------------+
    /// |eq     |EQ          |ueq      |UN | EQ     |Equal                    |
    /// +-------+------------+---------+------------+-------------------------+
    /// |one    |LT | GT     |ne       |UN | LT | GT|Not equal                |
    /// +-------+------------+---------+------------+-------------------------+
    /// |lt     |LT          |ult      |UN | LT     |Less than                |
    /// +-------+------------+---------+------------+-------------------------+
    /// |le     |LT | EQ     |ule      |UN | LT | EQ|Less than or equal       |
    /// +-------+------------+---------+------------+-------------------------+
    /// |gt     |GT          |ugt      |UN | GT     |Greater than             |
    /// +-------+------------+---------+------------+-------------------------+
    /// |ge     |GT | EQ     |uge      |UN | GT | EQ|Greater than or equal    |
    /// +-------+------------+---------+------------+-------------------------+
    /// ```
    ///
    /// The standard C comparison operators, `<, <=, >, >=`, are all ordered,
    /// so they are false if either operand is NaN. The C equality operator,
    /// `==`, is ordered, and since inequality is defined as the logical
    /// inverse it is *unordered*. They map to the `floatcc` condition
    /// codes as follows:
    ///
    /// ```text
    /// ==== ====== ============
    /// C    `Cond` Subset
    /// ==== ====== ============
    /// `==` eq     EQ
    /// `!=` ne     UN | LT | GT
    /// `<`  lt     LT
    /// `<=` le     LT | EQ
    /// `>`  gt     GT
    /// `>=` ge     GT | EQ
    /// ==== ====== ============
    /// ```
    ///
    /// This subset of condition codes also corresponds to the WebAssembly
    /// floating point comparisons of the same name.
    ///
    /// When this instruction compares floating point vectors, it returns a
    /// vector with the results of lane-wise comparisons.
    ///
    /// When comparing scalars, the result is:
    ///     - `1` if the condition holds.
    ///     - `0` if the condition does not hold.
    ///
    /// When comparing vectors, the result is:
    ///     - `-1` (i.e. all ones) in each lane where the condition holds.
    ///     - `0` in each lane where the condition does not hold.
    ///
    /// Inputs:
    ///
    /// - Cond: A floating point comparison condition code
    /// - x: A scalar or vector floating point number
    /// - y: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a:
    #[allow(non_snake_case, reason = "generated code")]
    fn fcmp<T1: Into<ir::condcodes::FloatCC>>(self, Cond: T1, x: ir::Value, y: ir::Value) -> Value {
        let Cond = Cond.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.FloatCompare(Opcode::Fcmp, ctrl_typevar, Cond, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point addition.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    /// - y: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: Result of applying operator to each lane
    #[allow(non_snake_case, reason = "generated code")]
    fn fadd(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Fadd, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point subtraction.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    /// - y: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: Result of applying operator to each lane
    #[allow(non_snake_case, reason = "generated code")]
    fn fsub(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Fsub, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point multiplication.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    /// - y: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: Result of applying operator to each lane
    #[allow(non_snake_case, reason = "generated code")]
    fn fmul(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Fmul, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point division.
    ///
    /// Unlike the integer division instructions ` and
    /// `udiv`, this can't trap. Division by zero is infinity or
    /// NaN, depending on the dividend.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    /// - y: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: Result of applying operator to each lane
    #[allow(non_snake_case, reason = "generated code")]
    fn fdiv(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Fdiv, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point square root.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: Result of applying operator to each lane
    #[allow(non_snake_case, reason = "generated code")]
    fn sqrt(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Sqrt, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point fused multiply-and-add.
    ///
    /// Computes `a := xy+z` without any intermediate rounding of the
    /// product.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    /// - y: A scalar or vector floating point number
    /// - z: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: Result of applying operator to each lane
    #[allow(non_snake_case, reason = "generated code")]
    fn fma(self, x: ir::Value, y: ir::Value, z: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Ternary(Opcode::Fma, ctrl_typevar, x, y, z); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point negation.
    ///
    /// Note that this is a pure bitwise operation.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: ``x`` with its sign bit inverted
    #[allow(non_snake_case, reason = "generated code")]
    fn fneg(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Fneg, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point absolute value.
    ///
    /// Note that this is a pure bitwise operation.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: ``x`` with its sign bit cleared
    #[allow(non_snake_case, reason = "generated code")]
    fn fabs(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Fabs, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point copy sign.
    ///
    /// Note that this is a pure bitwise operation. The sign bit from ``y`` is
    /// copied to the sign bit of ``x``.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    /// - y: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: ``x`` with its sign bit changed to that of ``y``
    #[allow(non_snake_case, reason = "generated code")]
    fn fcopysign(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Fcopysign, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point minimum, propagating NaNs using the WebAssembly rules.
    ///
    /// If either operand is NaN, this returns NaN with an unspecified sign. Furthermore, if
    /// each input NaN consists of a mantissa whose most significant bit is 1 and the rest is
    /// 0, then the output has the same form. Otherwise, the output mantissa's most significant
    /// bit is 1 and the rest is unspecified.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    /// - y: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: The smaller of ``x`` and ``y``
    #[allow(non_snake_case, reason = "generated code")]
    fn fmin(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Fmin, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Floating point maximum, propagating NaNs using the WebAssembly rules.
    ///
    /// If either operand is NaN, this returns NaN with an unspecified sign. Furthermore, if
    /// each input NaN consists of a mantissa whose most significant bit is 1 and the rest is
    /// 0, then the output has the same form. Otherwise, the output mantissa's most significant
    /// bit is 1 and the rest is unspecified.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    /// - y: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: The larger of ``x`` and ``y``
    #[allow(non_snake_case, reason = "generated code")]
    fn fmax(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Fmax, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Round floating point round to integral, towards positive infinity.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: ``x`` rounded to integral value
    #[allow(non_snake_case, reason = "generated code")]
    fn ceil(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Ceil, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Round floating point round to integral, towards negative infinity.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: ``x`` rounded to integral value
    #[allow(non_snake_case, reason = "generated code")]
    fn floor(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Floor, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Round floating point round to integral, towards zero.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: ``x`` rounded to integral value
    #[allow(non_snake_case, reason = "generated code")]
    fn trunc(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Trunc, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Round floating point round to integral, towards nearest with ties to
    /// even.
    ///
    /// Inputs:
    ///
    /// - x: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: ``x`` rounded to integral value
    #[allow(non_snake_case, reason = "generated code")]
    fn nearest(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Nearest, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Reinterpret the bits in `x` as a different type.
    ///
    /// The input and output types must be storable to memory and of the same
    /// size. A bitcast is equivalent to storing one type and loading the other
    /// type from the same address, both using the specified MemFlags.
    ///
    /// Note that this operation only supports the `big` or `little` MemFlags.
    /// The specified byte order only affects the result in the case where
    /// input and output types differ in lane count/size.  In this case, the
    /// operation is only valid if a byte order specifier is provided.
    ///
    /// Inputs:
    ///
    /// - MemTo (controlling type variable):
    /// - MemFlags: Memory operation flags
    /// - x: Any type that can be stored in memory
    ///
    /// Outputs:
    ///
    /// - a: Bits of `x` reinterpreted
    #[allow(non_snake_case, reason = "generated code")]
    fn bitcast<T1: Into<ir::MemFlags>>(self, MemTo: crate::ir::Type, MemFlags: T1, x: ir::Value) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.LoadNoOffset(Opcode::Bitcast, MemTo, MemFlags, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Copies a scalar value to a vector value.  The scalar is copied into the
    /// least significant lane of the vector, and all other lanes will be zero.
    ///
    /// Inputs:
    ///
    /// - TxN (controlling type variable): A SIMD vector type
    /// - s: A scalar value
    ///
    /// Outputs:
    ///
    /// - a: A vector value
    #[allow(non_snake_case, reason = "generated code")]
    fn scalar_to_vector(self, TxN: crate::ir::Type, s: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::ScalarToVector, TxN, s); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert `x` to an integer mask.
    ///
    /// Non-zero maps to all 1s and zero maps to all 0s.
    ///
    /// Inputs:
    ///
    /// - IntTo (controlling type variable): An integer type
    /// - x: A scalar whose values are truthy
    ///
    /// Outputs:
    ///
    /// - a: An integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn bmask(self, IntTo: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::Bmask, IntTo, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert `x` to a smaller integer type by discarding
    /// the most significant bits.
    ///
    /// This is the same as reducing modulo `2^n`.
    ///
    /// Inputs:
    ///
    /// - Int (controlling type variable): A scalar integer type
    /// - x: A scalar integer type, wider than the controlling type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn ireduce(self, Int: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::Ireduce, Int, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Combine `x` and `y` into a vector with twice the lanes but half the integer width while
    /// saturating overflowing values to the signed maximum and minimum.
    ///
    /// The lanes will be concatenated after narrowing. For example, when `x` and `y` are `i32x4`
    /// and `x = [x3, x2, x1, x0]` and `y = [y3, y2, y1, y0]`, then after narrowing the value
    /// returned is an `i16x8`: `a = [y3', y2', y1', y0', x3', x2', x1', x0']`.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integer lanes 16, 32, or 64 bits wide
    /// - y: A SIMD vector type containing integer lanes 16, 32, or 64 bits wide
    ///
    /// Outputs:
    ///
    /// - a:
    #[allow(non_snake_case, reason = "generated code")]
    fn snarrow(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Snarrow, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Combine `x` and `y` into a vector with twice the lanes but half the integer width while
    /// saturating overflowing values to the unsigned maximum and minimum.
    ///
    /// Note that all input lanes are considered signed: any negative lanes will overflow and be
    /// replaced with the unsigned minimum, `0x00`.
    ///
    /// The lanes will be concatenated after narrowing. For example, when `x` and `y` are `i32x4`
    /// and `x = [x3, x2, x1, x0]` and `y = [y3, y2, y1, y0]`, then after narrowing the value
    /// returned is an `i16x8`: `a = [y3', y2', y1', y0', x3', x2', x1', x0']`.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integer lanes 16, 32, or 64 bits wide
    /// - y: A SIMD vector type containing integer lanes 16, 32, or 64 bits wide
    ///
    /// Outputs:
    ///
    /// - a:
    #[allow(non_snake_case, reason = "generated code")]
    fn unarrow(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Unarrow, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Combine `x` and `y` into a vector with twice the lanes but half the integer width while
    /// saturating overflowing values to the unsigned maximum and minimum.
    ///
    /// Note that all input lanes are considered unsigned: any negative values will be interpreted as unsigned, overflowing and being replaced with the unsigned maximum.
    ///
    /// The lanes will be concatenated after narrowing. For example, when `x` and `y` are `i32x4`
    /// and `x = [x3, x2, x1, x0]` and `y = [y3, y2, y1, y0]`, then after narrowing the value
    /// returned is an `i16x8`: `a = [y3', y2', y1', y0', x3', x2', x1', x0']`.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integer lanes 16, 32, or 64 bits wide
    /// - y: A SIMD vector type containing integer lanes 16, 32, or 64 bits wide
    ///
    /// Outputs:
    ///
    /// - a:
    #[allow(non_snake_case, reason = "generated code")]
    fn uunarrow(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Uunarrow, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Widen the low lanes of `x` using signed extension.
    ///
    /// This will double the lane width and halve the number of lanes.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integer lanes 8, 16, or 32 bits wide.
    ///
    /// Outputs:
    ///
    /// - a:
    #[allow(non_snake_case, reason = "generated code")]
    fn swiden_low(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::SwidenLow, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Widen the high lanes of `x` using signed extension.
    ///
    /// This will double the lane width and halve the number of lanes.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integer lanes 8, 16, or 32 bits wide.
    ///
    /// Outputs:
    ///
    /// - a:
    #[allow(non_snake_case, reason = "generated code")]
    fn swiden_high(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::SwidenHigh, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Widen the low lanes of `x` using unsigned extension.
    ///
    /// This will double the lane width and halve the number of lanes.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integer lanes 8, 16, or 32 bits wide.
    ///
    /// Outputs:
    ///
    /// - a:
    #[allow(non_snake_case, reason = "generated code")]
    fn uwiden_low(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::UwidenLow, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Widen the high lanes of `x` using unsigned extension.
    ///
    /// This will double the lane width and halve the number of lanes.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integer lanes 8, 16, or 32 bits wide.
    ///
    /// Outputs:
    ///
    /// - a:
    #[allow(non_snake_case, reason = "generated code")]
    fn uwiden_high(self, x: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::UwidenHigh, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Does lane-wise integer pairwise addition on two operands, putting the
    /// combined results into a single vector result. Here a pair refers to adjacent
    /// lanes in a vector, i.e. i*2 + (i*2+1) for i == num_lanes/2. The first operand
    /// pairwise add results will make up the low half of the resulting vector while
    /// the second operand pairwise add results will make up the upper half of the
    /// resulting vector.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type containing integer lanes 8, 16, or 32 bits wide.
    /// - y: A SIMD vector type containing integer lanes 8, 16, or 32 bits wide.
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type containing integer lanes 8, 16, or 32 bits wide.
    #[allow(non_snake_case, reason = "generated code")]
    fn iadd_pairwise(self, x: ir::Value, y: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::IaddPairwise, ctrl_typevar, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// An instruction with equivalent semantics to `pmaddubsw` on x86.
    ///
    /// This instruction will take signed bytes from the first argument and
    /// multiply them against unsigned bytes in the second argument. Adjacent
    /// pairs are then added, with saturating, to a 16-bit value and are packed
    /// into the result.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type consisting of 16 lanes of 8-bit integers
    /// - y: A SIMD vector type consisting of 16 lanes of 8-bit integers
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector with exactly 8 lanes of 16-bit values
    #[allow(non_snake_case, reason = "generated code")]
    fn x86_pmaddubsw(self, x: ir::Value, y: ir::Value) -> Value {
        let (inst, dfg) = self.Binary(Opcode::X86Pmaddubsw, types::INVALID, x, y); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert `x` to a larger integer type by zero-extending.
    ///
    /// Each lane in `x` is converted to a larger integer type by adding
    /// zeroes. The result has the same numerical value as `x` when both are
    /// interpreted as unsigned integers.
    ///
    /// The result type must have the same number of vector lanes as the input,
    /// and each lane must not have fewer bits that the input lanes. If the
    /// input and output types are the same, this is a no-op.
    ///
    /// Inputs:
    ///
    /// - Int (controlling type variable): A scalar integer type
    /// - x: A scalar integer type, narrower than the controlling type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn uextend(self, Int: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::Uextend, Int, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert `x` to a larger integer type by sign-extending.
    ///
    /// Each lane in `x` is converted to a larger integer type by replicating
    /// the sign bit. The result has the same numerical value as `x` when both
    /// are interpreted as signed integers.
    ///
    /// The result type must have the same number of vector lanes as the input,
    /// and each lane must not have fewer bits that the input lanes. If the
    /// input and output types are the same, this is a no-op.
    ///
    /// Inputs:
    ///
    /// - Int (controlling type variable): A scalar integer type
    /// - x: A scalar integer type, narrower than the controlling type
    ///
    /// Outputs:
    ///
    /// - a: A scalar integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn sextend(self, Int: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::Sextend, Int, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert `x` to a larger floating point format.
    ///
    /// Each lane in `x` is converted to the destination floating point format.
    /// This is an exact operation.
    ///
    /// Cranelift currently only supports two floating point formats
    /// - `f32` and `f64`. This may change in the future.
    ///
    /// The result type must have the same number of vector lanes as the input,
    /// and the result lanes must not have fewer bits than the input lanes.
    ///
    /// Inputs:
    ///
    /// - FloatScalar (controlling type variable): A scalar only floating point number
    /// - x: A scalar only floating point number, narrower than the controlling type
    ///
    /// Outputs:
    ///
    /// - a: A scalar only floating point number
    #[allow(non_snake_case, reason = "generated code")]
    fn fpromote(self, FloatScalar: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::Fpromote, FloatScalar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert `x` to a smaller floating point format.
    ///
    /// Each lane in `x` is converted to the destination floating point format
    /// by rounding to nearest, ties to even.
    ///
    /// Cranelift currently only supports two floating point formats
    /// - `f32` and `f64`. This may change in the future.
    ///
    /// The result type must have the same number of vector lanes as the input,
    /// and the result lanes must not have more bits than the input lanes.
    ///
    /// Inputs:
    ///
    /// - FloatScalar (controlling type variable): A scalar only floating point number
    /// - x: A scalar only floating point number, wider than the controlling type
    ///
    /// Outputs:
    ///
    /// - a: A scalar only floating point number
    #[allow(non_snake_case, reason = "generated code")]
    fn fdemote(self, FloatScalar: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::Fdemote, FloatScalar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert `x` to a smaller floating point format.
    ///
    /// Each lane in `x` is converted to the destination floating point format
    /// by rounding to nearest, ties to even.
    ///
    /// Cranelift currently only supports two floating point formats
    /// - `f32` and `f64`. This may change in the future.
    ///
    /// Fvdemote differs from fdemote in that with fvdemote it targets vectors.
    /// Fvdemote is constrained to having the input type being F64x2 and the result
    /// type being F32x4. The result lane that was the upper half of the input lane
    /// is initialized to zero.
    ///
    /// Inputs:
    ///
    /// - x: A SIMD vector type consisting of 2 lanes of 64-bit floats
    ///
    /// Outputs:
    ///
    /// - a: A SIMD vector type consisting of 4 lanes of 32-bit floats
    #[allow(non_snake_case, reason = "generated code")]
    fn fvdemote(self, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::Fvdemote, types::INVALID, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Converts packed single precision floating point to packed double precision floating point.
    ///
    /// Considering only the lower half of the register, the low lanes in `x` are interpreted as
    /// single precision floats that are then converted to a double precision floats.
    ///
    /// The result type will have half the number of vector lanes as the input. Fvpromote_low is
    /// constrained to input F32x4 with a result type of F64x2.
    ///
    /// Inputs:
    ///
    /// - a: A SIMD vector type consisting of 4 lanes of 32-bit floats
    ///
    /// Outputs:
    ///
    /// - x: A SIMD vector type consisting of 2 lanes of 64-bit floats
    #[allow(non_snake_case, reason = "generated code")]
    fn fvpromote_low(self, a: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::FvpromoteLow, types::INVALID, a); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Converts floating point scalars to unsigned integer.
    ///
    /// Only operates on `x` if it is a scalar. If `x` is NaN or if
    /// the unsigned integral value cannot be represented in the result
    /// type, this instruction traps.
    ///
    /// Inputs:
    ///
    /// - IntTo (controlling type variable): An scalar only integer type
    /// - x: A scalar only floating point number
    ///
    /// Outputs:
    ///
    /// - a: An scalar only integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn fcvt_to_uint(self, IntTo: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::FcvtToUint, IntTo, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Converts floating point scalars to signed integer.
    ///
    /// Only operates on `x` if it is a scalar. If `x` is NaN or if
    /// the unsigned integral value cannot be represented in the result
    /// type, this instruction traps.
    ///
    /// Inputs:
    ///
    /// - IntTo (controlling type variable): An scalar only integer type
    /// - x: A scalar only floating point number
    ///
    /// Outputs:
    ///
    /// - a: An scalar only integer type
    #[allow(non_snake_case, reason = "generated code")]
    fn fcvt_to_sint(self, IntTo: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::FcvtToSint, IntTo, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert floating point to unsigned integer as fcvt_to_uint does, but
    /// saturates the input instead of trapping. NaN and negative values are
    /// converted to 0.
    ///
    /// Inputs:
    ///
    /// - IntTo (controlling type variable): A larger integer type with the same number of lanes
    /// - x: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: A larger integer type with the same number of lanes
    #[allow(non_snake_case, reason = "generated code")]
    fn fcvt_to_uint_sat(self, IntTo: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::FcvtToUintSat, IntTo, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert floating point to signed integer as fcvt_to_sint does, but
    /// saturates the input instead of trapping. NaN values are converted to 0.
    ///
    /// Inputs:
    ///
    /// - IntTo (controlling type variable): A larger integer type with the same number of lanes
    /// - x: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: A larger integer type with the same number of lanes
    #[allow(non_snake_case, reason = "generated code")]
    fn fcvt_to_sint_sat(self, IntTo: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::FcvtToSintSat, IntTo, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// A float-to-integer conversion instruction for vectors-of-floats which
    /// has the same semantics as `cvttp{s,d}2dq` on x86. This specifically
    /// returns `INT_MIN` for NaN or out-of-bounds lanes.
    ///
    /// Inputs:
    ///
    /// - IntTo (controlling type variable): A larger integer type with the same number of lanes
    /// - x: A scalar or vector floating point number
    ///
    /// Outputs:
    ///
    /// - a: A larger integer type with the same number of lanes
    #[allow(non_snake_case, reason = "generated code")]
    fn x86_cvtt2dq(self, IntTo: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::X86Cvtt2dq, IntTo, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert unsigned integer to floating point.
    ///
    /// Each lane in `x` is interpreted as an unsigned integer and converted to
    /// floating point using round to nearest, ties to even.
    ///
    /// The result type must have the same number of vector lanes as the input.
    ///
    /// Inputs:
    ///
    /// - FloatTo (controlling type variable): A scalar or vector floating point number
    /// - x: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector floating point number
    #[allow(non_snake_case, reason = "generated code")]
    fn fcvt_from_uint(self, FloatTo: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::FcvtFromUint, FloatTo, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Convert signed integer to floating point.
    ///
    /// Each lane in `x` is interpreted as a signed integer and converted to
    /// floating point using round to nearest, ties to even.
    ///
    /// The result type must have the same number of vector lanes as the input.
    ///
    /// Inputs:
    ///
    /// - FloatTo (controlling type variable): A scalar or vector floating point number
    /// - x: A scalar or vector integer type
    ///
    /// Outputs:
    ///
    /// - a: A scalar or vector floating point number
    #[allow(non_snake_case, reason = "generated code")]
    fn fcvt_from_sint(self, FloatTo: crate::ir::Type, x: ir::Value) -> Value {
        let (inst, dfg) = self.Unary(Opcode::FcvtFromSint, FloatTo, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Split an integer into low and high parts.
    ///
    /// Vectors of integers are split lane-wise, so the results have the same
    /// number of lanes as the input, but the lanes are half the size.
    ///
    /// Returns the low half of `x` and the high half of `x` as two independent
    /// values.
    ///
    /// Inputs:
    ///
    /// - x: An integer type of width `i16` upwards
    ///
    /// Outputs:
    ///
    /// - lo: The low bits of `x`
    /// - hi: The high bits of `x`
    #[allow(non_snake_case, reason = "generated code")]
    fn isplit(self, x: ir::Value) -> (Value, Value) {
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Unary(Opcode::Isplit, ctrl_typevar, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        let results = &dfg.inst_results(inst)[0..2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1303
        (results[0], results[1]) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1308
    }

    /// Concatenate low and high bits to form a larger integer type.
    ///
    /// Vectors of integers are concatenated lane-wise such that the result has
    /// the same number of lanes as the inputs, but the lanes are twice the
    /// size.
    ///
    /// Inputs:
    ///
    /// - lo: An integer type of width up to `i64`
    /// - hi: An integer type of width up to `i64`
    ///
    /// Outputs:
    ///
    /// - a: The concatenation of `lo` and `hi`
    #[allow(non_snake_case, reason = "generated code")]
    fn iconcat(self, lo: ir::Value, hi: ir::Value) -> Value {
        let ctrl_typevar = self.data_flow_graph().value_type(lo); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.Binary(Opcode::Iconcat, ctrl_typevar, lo, hi); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Atomically read-modify-write memory at `p`, with second operand `x`.  The old value is
    /// returned.  `p` has the type of the target word size, and `x` may be any integer type; note
    /// that some targets require specific target features to be enabled in order to support 128-bit
    /// integer atomics.  The type of the returned value is the same as the type of `x`.  This
    /// operation is sequentially consistent and creates happens-before edges that order normal
    /// (non-atomic) loads and stores.
    ///
    /// Inputs:
    ///
    /// - AtomicMem (controlling type variable): Any type that can be stored in memory, which can be used in an atomic operation
    /// - MemFlags: Memory operation flags
    /// - AtomicRmwOp: Atomic Read-Modify-Write Ops
    /// - p: An integer address type
    /// - x: Value to be atomically stored
    ///
    /// Outputs:
    ///
    /// - a: Value atomically loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn atomic_rmw<T1: Into<ir::MemFlags>, T2: Into<ir::AtomicRmwOp>>(self, AtomicMem: crate::ir::Type, MemFlags: T1, AtomicRmwOp: T2, p: ir::Value, x: ir::Value) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let AtomicRmwOp = AtomicRmwOp.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.AtomicRmw(Opcode::AtomicRmw, AtomicMem, MemFlags, AtomicRmwOp, p, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Perform an atomic compare-and-swap operation on memory at `p`, with expected value `e`,
    /// storing `x` if the value at `p` equals `e`.  The old value at `p` is returned,
    /// regardless of whether the operation succeeds or fails.  `p` has the type of the target
    /// word size, and `x` and `e` must have the same type and the same size, which may be any
    /// integer type; note that some targets require specific target features to be enabled in order
    /// to support 128-bit integer atomics.  The type of the returned value is the same as the type
    /// of `x` and `e`.  This operation is sequentially consistent and creates happens-before edges
    /// that order normal (non-atomic) loads and stores.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    /// - e: Expected value in CAS
    /// - x: Value to be atomically stored
    ///
    /// Outputs:
    ///
    /// - a: Value atomically loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn atomic_cas<T1: Into<ir::MemFlags>>(self, MemFlags: T1, p: ir::Value, e: ir::Value, x: ir::Value) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.AtomicCas(Opcode::AtomicCas, ctrl_typevar, MemFlags, p, e, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Atomically load from memory at `p`.
    ///
    /// This is a polymorphic instruction that can load any value type which has a memory
    /// representation.  It can only be used for integer types; note that some targets require
    /// specific target features to be enabled in order to support 128-bit integer atomics. This
    /// operation is sequentially consistent and creates happens-before edges that order normal
    /// (non-atomic) loads and stores.
    ///
    /// Inputs:
    ///
    /// - AtomicMem (controlling type variable): Any type that can be stored in memory, which can be used in an atomic operation
    /// - MemFlags: Memory operation flags
    /// - p: An integer address type
    ///
    /// Outputs:
    ///
    /// - a: Value atomically loaded
    #[allow(non_snake_case, reason = "generated code")]
    fn atomic_load<T1: Into<ir::MemFlags>>(self, AtomicMem: crate::ir::Type, MemFlags: T1, p: ir::Value) -> Value {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let (inst, dfg) = self.LoadNoOffset(Opcode::AtomicLoad, AtomicMem, MemFlags, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// Atomically store `x` to memory at `p`.
    ///
    /// This is a polymorphic instruction that can store any value type with a memory
    /// representation.  It can only be used for integer types; note that some targets require
    /// specific target features to be enabled in order to support 128-bit integer atomics This
    /// operation is sequentially consistent and creates happens-before edges that order normal
    /// (non-atomic) loads and stores.
    ///
    /// Inputs:
    ///
    /// - MemFlags: Memory operation flags
    /// - x: Value to be atomically stored
    /// - p: An integer address type
    #[allow(non_snake_case, reason = "generated code")]
    fn atomic_store<T1: Into<ir::MemFlags>>(self, MemFlags: T1, x: ir::Value, p: ir::Value) -> Inst {
        let MemFlags = MemFlags.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.StoreNoOffset(Opcode::AtomicStore, ctrl_typevar, MemFlags, x, p); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// A memory fence.  This must provide ordering to ensure that, at a minimum, neither loads
    /// nor stores of any kind may move forwards or backwards across the fence.  This operation
    /// is sequentially consistent.
    #[allow(non_snake_case, reason = "generated code")]
    fn fence(self) -> Inst {
        let (inst, dfg) = self.NullAry(Opcode::Fence, types::INVALID); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// Return a fixed length sub vector, extracted from a dynamic vector.
    ///
    /// Inputs:
    ///
    /// - x: The dynamic vector to extract from
    /// - y: 128-bit vector index
    ///
    /// Outputs:
    ///
    /// - a: New fixed vector
    #[allow(non_snake_case, reason = "generated code")]
    fn extract_vector<T1: Into<ir::immediates::Uimm8>>(self, x: ir::Value, y: T1) -> Value {
        let y = y.into(); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1221
        let ctrl_typevar = self.data_flow_graph().value_type(x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1240
        let (inst, dfg) = self.BinaryImm8(Opcode::ExtractVector, ctrl_typevar, y, x); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        dfg.first_result(inst)
    }

    /// A compiler barrier that acts as an immovable marker from IR input to machine-code output.
    ///
    /// This "sequence point" can have debug tags attached to it, and these tags will be
    /// noted in the output `MachBuffer`.
    ///
    /// It prevents motion of any other side-effects across this boundary.
    #[allow(non_snake_case, reason = "generated code")]
    fn sequence_point(self) -> Inst {
        let (inst, dfg) = self.NullAry(Opcode::SequencePoint, types::INVALID); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1289
        crate::trace!("inserted {inst:?}: {}", dfg.display_inst(inst)); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1290
        inst // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1296
    }

    /// AtomicCas(imms=(flags: ir::MemFlags), vals=3, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn AtomicCas(self, opcode: Opcode, ctrl_typevar: Type, flags: ir::MemFlags, arg0: Value, arg1: Value, arg2: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::AtomicCas {
            opcode,
            flags, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args: [arg0, arg1, arg2], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// AtomicRmw(imms=(flags: ir::MemFlags, op: ir::AtomicRmwOp), vals=2, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn AtomicRmw(self, opcode: Opcode, ctrl_typevar: Type, flags: ir::MemFlags, op: ir::AtomicRmwOp, arg0: Value, arg1: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::AtomicRmw {
            opcode,
            flags, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            op, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args: [arg0, arg1], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// Binary(imms=(), vals=2, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn Binary(self, opcode: Opcode, ctrl_typevar: Type, arg0: Value, arg1: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::Binary {
            opcode,
            args: [arg0, arg1], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// BinaryImm64(imms=(imm: ir::immediates::Imm64), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn BinaryImm64(self, opcode: Opcode, ctrl_typevar: Type, imm: ir::immediates::Imm64, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let mut data = ir::InstructionData::BinaryImm64 {
            opcode,
            imm, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            arg: arg0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        data.mask_immediates(ctrl_typevar); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1094
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// BinaryImm8(imms=(imm: ir::immediates::Uimm8), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn BinaryImm8(self, opcode: Opcode, ctrl_typevar: Type, imm: ir::immediates::Uimm8, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::BinaryImm8 {
            opcode,
            imm, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            arg: arg0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// BranchTable(imms=(table: ir::JumpTable), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn BranchTable(self, opcode: Opcode, ctrl_typevar: Type, table: ir::JumpTable, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::BranchTable {
            opcode,
            table, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            arg: arg0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// Brif(imms=(), vals=1, blocks=2, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn Brif(self, opcode: Opcode, ctrl_typevar: Type, block0: ir::BlockCall, block1: ir::BlockCall, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::Brif {
            opcode,
            arg: arg0,
            blocks: [block0, block1], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1021
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// Call(imms=(func_ref: ir::FuncRef), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn Call(self, opcode: Opcode, ctrl_typevar: Type, func_ref: ir::FuncRef, args: ir::ValueList) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::Call {
            opcode,
            func_ref, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// CallIndirect(imms=(sig_ref: ir::SigRef), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn CallIndirect(self, opcode: Opcode, ctrl_typevar: Type, sig_ref: ir::SigRef, args: ir::ValueList) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::CallIndirect {
            opcode,
            sig_ref, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// CondTrap(imms=(code: ir::TrapCode), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn CondTrap(self, opcode: Opcode, ctrl_typevar: Type, code: ir::TrapCode, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::CondTrap {
            opcode,
            code, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            arg: arg0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// DynamicStackLoad(imms=(dynamic_stack_slot: ir::DynamicStackSlot), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn DynamicStackLoad(self, opcode: Opcode, ctrl_typevar: Type, dynamic_stack_slot: ir::DynamicStackSlot) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::DynamicStackLoad {
            opcode,
            dynamic_stack_slot, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// DynamicStackStore(imms=(dynamic_stack_slot: ir::DynamicStackSlot), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn DynamicStackStore(self, opcode: Opcode, ctrl_typevar: Type, dynamic_stack_slot: ir::DynamicStackSlot, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::DynamicStackStore {
            opcode,
            dynamic_stack_slot, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            arg: arg0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// ExceptionHandlerAddress(imms=(imm: ir::immediates::Imm64), vals=0, blocks=0, raw_blocks=1)
    #[allow(non_snake_case, reason = "generated code")]
    fn ExceptionHandlerAddress(self, opcode: Opcode, ctrl_typevar: Type, block0: ir::Block, imm: ir::immediates::Imm64) -> (Inst, &'f mut ir::DataFlowGraph) {
        let mut data = ir::InstructionData::ExceptionHandlerAddress {
            opcode,
            imm, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            block: block0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        data.mask_immediates(ctrl_typevar); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1094
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// FloatCompare(imms=(cond: ir::condcodes::FloatCC), vals=2, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn FloatCompare(self, opcode: Opcode, ctrl_typevar: Type, cond: ir::condcodes::FloatCC, arg0: Value, arg1: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::FloatCompare {
            opcode,
            cond, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args: [arg0, arg1], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// FuncAddr(imms=(func_ref: ir::FuncRef), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn FuncAddr(self, opcode: Opcode, ctrl_typevar: Type, func_ref: ir::FuncRef) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::FuncAddr {
            opcode,
            func_ref, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// IntAddTrap(imms=(code: ir::TrapCode), vals=2, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn IntAddTrap(self, opcode: Opcode, ctrl_typevar: Type, code: ir::TrapCode, arg0: Value, arg1: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::IntAddTrap {
            opcode,
            code, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args: [arg0, arg1], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// IntCompare(imms=(cond: ir::condcodes::IntCC), vals=2, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn IntCompare(self, opcode: Opcode, ctrl_typevar: Type, cond: ir::condcodes::IntCC, arg0: Value, arg1: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::IntCompare {
            opcode,
            cond, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args: [arg0, arg1], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// IntCompareImm(imms=(cond: ir::condcodes::IntCC, imm: ir::immediates::Imm64), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn IntCompareImm(self, opcode: Opcode, ctrl_typevar: Type, cond: ir::condcodes::IntCC, imm: ir::immediates::Imm64, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let mut data = ir::InstructionData::IntCompareImm {
            opcode,
            cond, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            imm, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            arg: arg0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        data.mask_immediates(ctrl_typevar); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1094
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// Jump(imms=(), vals=0, blocks=1, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn Jump(self, opcode: Opcode, ctrl_typevar: Type, block0: ir::BlockCall) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::Jump {
            opcode,
            destination: block0
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// Load(imms=(flags: ir::MemFlags, offset: ir::immediates::Offset32), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn Load(self, opcode: Opcode, ctrl_typevar: Type, flags: ir::MemFlags, offset: ir::immediates::Offset32, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::Load {
            opcode,
            flags, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            offset, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            arg: arg0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// LoadNoOffset(imms=(flags: ir::MemFlags), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn LoadNoOffset(self, opcode: Opcode, ctrl_typevar: Type, flags: ir::MemFlags, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::LoadNoOffset {
            opcode,
            flags, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            arg: arg0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// MultiAry(imms=(), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn MultiAry(self, opcode: Opcode, ctrl_typevar: Type, args: ir::ValueList) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::MultiAry {
            opcode,
            args,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// NullAry(imms=(), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn NullAry(self, opcode: Opcode, ctrl_typevar: Type) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::NullAry {
            opcode,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// Shuffle(imms=(imm: ir::Immediate), vals=2, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn Shuffle(self, opcode: Opcode, ctrl_typevar: Type, imm: ir::Immediate, arg0: Value, arg1: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::Shuffle {
            opcode,
            imm, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args: [arg0, arg1], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// StackLoad(imms=(stack_slot: ir::StackSlot, offset: ir::immediates::Offset32), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn StackLoad(self, opcode: Opcode, ctrl_typevar: Type, stack_slot: ir::StackSlot, offset: ir::immediates::Offset32) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::StackLoad {
            opcode,
            stack_slot, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            offset, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// StackStore(imms=(stack_slot: ir::StackSlot, offset: ir::immediates::Offset32), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn StackStore(self, opcode: Opcode, ctrl_typevar: Type, stack_slot: ir::StackSlot, offset: ir::immediates::Offset32, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::StackStore {
            opcode,
            stack_slot, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            offset, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            arg: arg0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// Store(imms=(flags: ir::MemFlags, offset: ir::immediates::Offset32), vals=2, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn Store(self, opcode: Opcode, ctrl_typevar: Type, flags: ir::MemFlags, offset: ir::immediates::Offset32, arg0: Value, arg1: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::Store {
            opcode,
            flags, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            offset, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args: [arg0, arg1], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// StoreNoOffset(imms=(flags: ir::MemFlags), vals=2, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn StoreNoOffset(self, opcode: Opcode, ctrl_typevar: Type, flags: ir::MemFlags, arg0: Value, arg1: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::StoreNoOffset {
            opcode,
            flags, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args: [arg0, arg1], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// Ternary(imms=(), vals=3, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn Ternary(self, opcode: Opcode, ctrl_typevar: Type, arg0: Value, arg1: Value, arg2: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::Ternary {
            opcode,
            args: [arg0, arg1, arg2], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// TernaryImm8(imms=(imm: ir::immediates::Uimm8), vals=2, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn TernaryImm8(self, opcode: Opcode, ctrl_typevar: Type, imm: ir::immediates::Uimm8, arg0: Value, arg1: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::TernaryImm8 {
            opcode,
            imm, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args: [arg0, arg1], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1009
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// Trap(imms=(code: ir::TrapCode), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn Trap(self, opcode: Opcode, ctrl_typevar: Type, code: ir::TrapCode) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::Trap {
            opcode,
            code, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// TryCall(imms=(func_ref: ir::FuncRef, exception: ir::ExceptionTable), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn TryCall(self, opcode: Opcode, ctrl_typevar: Type, func_ref: ir::FuncRef, exception: ir::ExceptionTable, args: ir::ValueList) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::TryCall {
            opcode,
            func_ref, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            exception, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// TryCallIndirect(imms=(exception: ir::ExceptionTable), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn TryCallIndirect(self, opcode: Opcode, ctrl_typevar: Type, exception: ir::ExceptionTable, args: ir::ValueList) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::TryCallIndirect {
            opcode,
            exception, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
            args,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// Unary(imms=(), vals=1, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn Unary(self, opcode: Opcode, ctrl_typevar: Type, arg0: Value) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::Unary {
            opcode,
            arg: arg0,
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// UnaryConst(imms=(constant_handle: ir::Constant), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn UnaryConst(self, opcode: Opcode, ctrl_typevar: Type, constant_handle: ir::Constant) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::UnaryConst {
            opcode,
            constant_handle, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// UnaryGlobalValue(imms=(global_value: ir::GlobalValue), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn UnaryGlobalValue(self, opcode: Opcode, ctrl_typevar: Type, global_value: ir::GlobalValue) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::UnaryGlobalValue {
            opcode,
            global_value, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// UnaryIeee16(imms=(imm: ir::immediates::Ieee16), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn UnaryIeee16(self, opcode: Opcode, ctrl_typevar: Type, imm: ir::immediates::Ieee16) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::UnaryIeee16 {
            opcode,
            imm, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// UnaryIeee32(imms=(imm: ir::immediates::Ieee32), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn UnaryIeee32(self, opcode: Opcode, ctrl_typevar: Type, imm: ir::immediates::Ieee32) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::UnaryIeee32 {
            opcode,
            imm, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// UnaryIeee64(imms=(imm: ir::immediates::Ieee64), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn UnaryIeee64(self, opcode: Opcode, ctrl_typevar: Type, imm: ir::immediates::Ieee64) -> (Inst, &'f mut ir::DataFlowGraph) {
        let data = ir::InstructionData::UnaryIeee64 {
            opcode,
            imm, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }

    /// UnaryImm(imms=(imm: ir::immediates::Imm64), vals=0, blocks=0, raw_blocks=0)
    #[allow(non_snake_case, reason = "generated code")]
    fn UnaryImm(self, opcode: Opcode, ctrl_typevar: Type, imm: ir::immediates::Imm64) -> (Inst, &'f mut ir::DataFlowGraph) {
        let mut data = ir::InstructionData::UnaryImm {
            opcode,
            imm, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:996
        }
        ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1091
        data.mask_immediates(ctrl_typevar); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1094
        debug_assert_eq!(opcode.format(), InstructionFormat::from(&data), "Wrong InstructionFormat for Opcode: {opcode}"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_inst.rs:1098
        self.build(data, ctrl_typevar)
    }
}
