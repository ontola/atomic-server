pub fn print(inst: &RawInst) -> String {
match inst {

        RawInst::Nop {  } => {
            
            format!("nop")
        }
        
        RawInst::Ret {  } => {
            
            format!("ret")
        }
        
        RawInst::XJump { reg, } => {
            let reg = reg_name(**reg);

            format!("xjump {reg}")
        }
        
        RawInst::Xmov { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xmov {dst}, {src}")
        }
        
        RawInst::Xzero { dst, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xzero {dst}")
        }
        
        RawInst::Xone { dst, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xone {dst}")
        }
        
        RawInst::Xconst8 { dst,imm, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xconst8 {dst}, {imm}")
        }
        
        RawInst::Xconst16 { dst,imm, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xconst16 {dst}, {imm}")
        }
        
        RawInst::Xconst32 { dst,imm, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xconst32 {dst}, {imm}")
        }
        
        RawInst::Xconst64 { dst,imm, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xconst64 {dst}, {imm}")
        }
        
        RawInst::Xadd32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xadd32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xadd32U8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xadd32_u8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xadd32U32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xadd32_u32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xadd64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xadd64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xadd64U8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xadd64_u8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xadd64U32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xadd64_u32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmadd32 { dst,src1,src2,src3, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);
let src3 = reg_name(**src3);

            format!("xmadd32 {dst}, {src1}, {src2}, {src3}")
        }
        
        RawInst::Xmadd64 { dst,src1,src2,src3, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);
let src3 = reg_name(**src3);

            format!("xmadd64 {dst}, {src1}, {src2}, {src3}")
        }
        
        RawInst::Xsub32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xsub32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xsub32U8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xsub32_u8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xsub32U32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xsub32_u32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xsub64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xsub64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xsub64U8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xsub64_u8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xsub64U32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xsub64_u32 {dst}, {src1}, {src2}")
        }
        
        RawInst::XMul32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmul32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmul32S8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xmul32_s8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmul32S32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xmul32_s32 {dst}, {src1}, {src2}")
        }
        
        RawInst::XMul64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmul64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmul64S8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xmul64_s8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmul64S32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xmul64_s32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xctz32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xctz32 {dst}, {src}")
        }
        
        RawInst::Xctz64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xctz64 {dst}, {src}")
        }
        
        RawInst::Xclz32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xclz32 {dst}, {src}")
        }
        
        RawInst::Xclz64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xclz64 {dst}, {src}")
        }
        
        RawInst::Xpopcnt32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xpopcnt32 {dst}, {src}")
        }
        
        RawInst::Xpopcnt64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xpopcnt64 {dst}, {src}")
        }
        
        RawInst::Xrotl32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xrotl32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xrotl64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xrotl64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xrotr32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xrotr32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xrotr64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xrotr64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshl32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xshl32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshr32S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xshr32_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshr32U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xshr32_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshl64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xshl64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshr64S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xshr64_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshr64U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xshr64_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshl32U6 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xshl32_u6 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshr32SU6 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xshr32_s_u6 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshr32UU6 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xshr32_u_u6 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshl64U6 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xshl64_u6 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshr64SU6 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xshr64_s_u6 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xshr64UU6 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xshr64_u_u6 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xneg32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xneg32 {dst}, {src}")
        }
        
        RawInst::Xneg64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xneg64 {dst}, {src}")
        }
        
        RawInst::Xeq64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xeq64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xneq64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xneq64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xslt64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xslt64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xslteq64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xslteq64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xult64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xult64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xulteq64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xulteq64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xeq32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xeq32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xneq32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xneq32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xslt32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xslt32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xslteq32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xslteq32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xult32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xult32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xulteq32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xulteq32 {dst}, {src1}, {src2}")
        }
        
        RawInst::XLoad8U32O32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload8_u32_o32 {dst}, {addr}")
        }
        
        RawInst::XLoad8S32O32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload8_s32_o32 {dst}, {addr}")
        }
        
        RawInst::XLoad16LeU32O32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload16le_u32_o32 {dst}, {addr}")
        }
        
        RawInst::XLoad16LeS32O32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload16le_s32_o32 {dst}, {addr}")
        }
        
        RawInst::XLoad32LeO32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload32le_o32 {dst}, {addr}")
        }
        
        RawInst::XLoad64LeO32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload64le_o32 {dst}, {addr}")
        }
        
        RawInst::XStore8O32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore8_o32 {addr}, {src}")
        }
        
        RawInst::XStore16LeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore16le_o32 {addr}, {src}")
        }
        
        RawInst::XStore32LeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore32le_o32 {addr}, {src}")
        }
        
        RawInst::XStore64LeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore64le_o32 {addr}, {src}")
        }
        
        RawInst::XLoad8U32Z { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload8_u32_z {dst}, {addr}")
        }
        
        RawInst::XLoad8S32Z { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload8_s32_z {dst}, {addr}")
        }
        
        RawInst::XLoad16LeU32Z { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload16le_u32_z {dst}, {addr}")
        }
        
        RawInst::XLoad16LeS32Z { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload16le_s32_z {dst}, {addr}")
        }
        
        RawInst::XLoad32LeZ { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload32le_z {dst}, {addr}")
        }
        
        RawInst::XLoad64LeZ { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload64le_z {dst}, {addr}")
        }
        
        RawInst::XStore8Z { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore8_z {addr}, {src}")
        }
        
        RawInst::XStore16LeZ { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore16le_z {addr}, {src}")
        }
        
        RawInst::XStore32LeZ { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore32le_z {addr}, {src}")
        }
        
        RawInst::XStore64LeZ { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore64le_z {addr}, {src}")
        }
        
        RawInst::XLoad8U32G32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload8_u32_g32 {dst}, {addr}")
        }
        
        RawInst::XLoad8S32G32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload8_s32_g32 {dst}, {addr}")
        }
        
        RawInst::XLoad16LeU32G32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload16le_u32_g32 {dst}, {addr}")
        }
        
        RawInst::XLoad16LeS32G32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload16le_s32_g32 {dst}, {addr}")
        }
        
        RawInst::XLoad32LeG32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload32le_g32 {dst}, {addr}")
        }
        
        RawInst::XLoad64LeG32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload64le_g32 {dst}, {addr}")
        }
        
        RawInst::XStore8G32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore8_g32 {addr}, {src}")
        }
        
        RawInst::XStore16LeG32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore16le_g32 {addr}, {src}")
        }
        
        RawInst::XStore32LeG32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore32le_g32 {addr}, {src}")
        }
        
        RawInst::XStore64LeG32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore64le_g32 {addr}, {src}")
        }
        
        RawInst::XLoad8U32G32Bne { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload8_u32_g32bne {dst}, {addr}")
        }
        
        RawInst::XLoad8S32G32Bne { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload8_s32_g32bne {dst}, {addr}")
        }
        
        RawInst::XLoad16LeU32G32Bne { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload16le_u32_g32bne {dst}, {addr}")
        }
        
        RawInst::XLoad16LeS32G32Bne { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload16le_s32_g32bne {dst}, {addr}")
        }
        
        RawInst::XLoad32LeG32Bne { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload32le_g32bne {dst}, {addr}")
        }
        
        RawInst::XLoad64LeG32Bne { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload64le_g32bne {dst}, {addr}")
        }
        
        RawInst::XStore8G32Bne { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore8_g32bne {addr}, {src}")
        }
        
        RawInst::XStore16LeG32Bne { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore16le_g32bne {addr}, {src}")
        }
        
        RawInst::XStore32LeG32Bne { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore32le_g32bne {addr}, {src}")
        }
        
        RawInst::XStore64LeG32Bne { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore64le_g32bne {addr}, {src}")
        }
        
        RawInst::PushFrame {  } => {
            
            format!("push_frame")
        }
        
        RawInst::PopFrame {  } => {
            
            format!("pop_frame")
        }
        
        RawInst::PushFrameSave { amt,regs, } => {
            
            format!("push_frame_save {amt}, {regs:?}")
        }
        
        RawInst::PopFrameRestore { amt,regs, } => {
            
            format!("pop_frame_restore {amt}, {regs:?}")
        }
        
        RawInst::StackAlloc32 { amt, } => {
            
            format!("stack_alloc32 {amt}")
        }
        
        RawInst::StackFree32 { amt, } => {
            
            format!("stack_free32 {amt}")
        }
        
        RawInst::Zext8 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("zext8 {dst}, {src}")
        }
        
        RawInst::Zext16 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("zext16 {dst}, {src}")
        }
        
        RawInst::Zext32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("zext32 {dst}, {src}")
        }
        
        RawInst::Sext8 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("sext8 {dst}, {src}")
        }
        
        RawInst::Sext16 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("sext16 {dst}, {src}")
        }
        
        RawInst::Sext32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("sext32 {dst}, {src}")
        }
        
        RawInst::XAbs32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xabs32 {dst}, {src}")
        }
        
        RawInst::XAbs64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xabs64 {dst}, {src}")
        }
        
        RawInst::XDiv32S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xdiv32_s {dst}, {src1}, {src2}")
        }
        
        RawInst::XDiv64S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xdiv64_s {dst}, {src1}, {src2}")
        }
        
        RawInst::XDiv32U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xdiv32_u {dst}, {src1}, {src2}")
        }
        
        RawInst::XDiv64U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xdiv64_u {dst}, {src1}, {src2}")
        }
        
        RawInst::XRem32S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xrem32_s {dst}, {src1}, {src2}")
        }
        
        RawInst::XRem64S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xrem64_s {dst}, {src1}, {src2}")
        }
        
        RawInst::XRem32U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xrem32_u {dst}, {src1}, {src2}")
        }
        
        RawInst::XRem64U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xrem64_u {dst}, {src1}, {src2}")
        }
        
        RawInst::XBand32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xband32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xband32S8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xband32_s8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xband32S32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xband32_s32 {dst}, {src1}, {src2}")
        }
        
        RawInst::XBand64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xband64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xband64S8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xband64_s8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xband64S32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xband64_s32 {dst}, {src1}, {src2}")
        }
        
        RawInst::XBor32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xbor32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xbor32S8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xbor32_s8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xbor32S32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xbor32_s32 {dst}, {src1}, {src2}")
        }
        
        RawInst::XBor64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xbor64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xbor64S8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xbor64_s8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xbor64S32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xbor64_s32 {dst}, {src1}, {src2}")
        }
        
        RawInst::XBxor32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xbxor32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xbxor32S8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xbxor32_s8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xbxor32S32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xbxor32_s32 {dst}, {src1}, {src2}")
        }
        
        RawInst::XBxor64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xbxor64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xbxor64S8 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xbxor64_s8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Xbxor64S32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);

            format!("xbxor64_s32 {dst}, {src1}, {src2}")
        }
        
        RawInst::XBnot32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xbnot32 {dst}, {src}")
        }
        
        RawInst::XBnot64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xbnot64 {dst}, {src}")
        }
        
        RawInst::Xmin32U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmin32_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmin32S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmin32_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmax32U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmax32_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmax32S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmax32_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmin64U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmin64_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmin64S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmin64_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmax64U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmax64_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Xmax64S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmax64_s {dst}, {src1}, {src2}")
        }
        
        RawInst::XSelect32 { dst,cond,if_nonzero,if_zero, } => {
            let dst = reg_name(*dst.to_reg());
let cond = reg_name(**cond);
let if_nonzero = reg_name(**if_nonzero);
let if_zero = reg_name(**if_zero);

            format!("xselect32 {dst}, {cond}, {if_nonzero}, {if_zero}")
        }
        
        RawInst::XSelect64 { dst,cond,if_nonzero,if_zero, } => {
            let dst = reg_name(*dst.to_reg());
let cond = reg_name(**cond);
let if_nonzero = reg_name(**if_nonzero);
let if_zero = reg_name(**if_zero);

            format!("xselect64 {dst}, {cond}, {if_nonzero}, {if_zero}")
        }
        
        RawInst::Trap { code, } => {
            
            format!("trap // trap={code:?}")
        }
        
        RawInst::Xpcadd { dst,offset, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xpcadd {dst}, {offset}")
        }
        
        RawInst::XmovFp { dst, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xmov_fp {dst}")
        }
        
        RawInst::XmovLr { dst, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xmov_lr {dst}")
        }
        
        RawInst::Bswap32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("bswap32 {dst}, {src}")
        }
        
        RawInst::Bswap64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("bswap64 {dst}, {src}")
        }
        
        RawInst::Xadd32UoverflowTrap { dst, src1, src2,code, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xadd32_uoverflow_trap {dst}, {src1}, {src2} // trap={code:?}")
        }
        
        RawInst::Xadd64UoverflowTrap { dst, src1, src2,code, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xadd64_uoverflow_trap {dst}, {src1}, {src2} // trap={code:?}")
        }
        
        RawInst::XMulHi64S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmulhi64_s {dst}, {src1}, {src2}")
        }
        
        RawInst::XMulHi64U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("xmulhi64_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Xbmask32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xbmask32 {dst}, {src}")
        }
        
        RawInst::Xbmask64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xbmask64 {dst}, {src}")
        }
        
        RawInst::XLoad16BeU32O32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload16be_u32_o32 {dst}, {addr}")
        }
        
        RawInst::XLoad16BeS32O32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload16be_s32_o32 {dst}, {addr}")
        }
        
        RawInst::XLoad32BeO32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload32be_o32 {dst}, {addr}")
        }
        
        RawInst::XLoad64BeO32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("xload64be_o32 {dst}, {addr}")
        }
        
        RawInst::XStore16BeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore16be_o32 {addr}, {src}")
        }
        
        RawInst::XStore32BeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore32be_o32 {addr}, {src}")
        }
        
        RawInst::XStore64BeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("xstore64be_o32 {addr}, {src}")
        }
        
        RawInst::Fload32BeO32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("fload32be_o32 {dst}, {addr}")
        }
        
        RawInst::Fload64BeO32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("fload64be_o32 {dst}, {addr}")
        }
        
        RawInst::Fstore32BeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("fstore32be_o32 {addr}, {src}")
        }
        
        RawInst::Fstore64BeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("fstore64be_o32 {addr}, {src}")
        }
        
        RawInst::Fload32LeO32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("fload32le_o32 {dst}, {addr}")
        }
        
        RawInst::Fload64LeO32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("fload64le_o32 {dst}, {addr}")
        }
        
        RawInst::Fstore32LeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("fstore32le_o32 {addr}, {src}")
        }
        
        RawInst::Fstore64LeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("fstore64le_o32 {addr}, {src}")
        }
        
        RawInst::Fload32LeZ { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("fload32le_z {dst}, {addr}")
        }
        
        RawInst::Fload64LeZ { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("fload64le_z {dst}, {addr}")
        }
        
        RawInst::Fstore32LeZ { addr,src, } => {
            let src = reg_name(**src);

            format!("fstore32le_z {addr}, {src}")
        }
        
        RawInst::Fstore64LeZ { addr,src, } => {
            let src = reg_name(**src);

            format!("fstore64le_z {addr}, {src}")
        }
        
        RawInst::Fload32LeG32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("fload32le_g32 {dst}, {addr}")
        }
        
        RawInst::Fload64LeG32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("fload64le_g32 {dst}, {addr}")
        }
        
        RawInst::Fstore32LeG32 { addr,src, } => {
            let src = reg_name(**src);

            format!("fstore32le_g32 {addr}, {src}")
        }
        
        RawInst::Fstore64LeG32 { addr,src, } => {
            let src = reg_name(**src);

            format!("fstore64le_g32 {addr}, {src}")
        }
        
        RawInst::VLoad128O32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("vload128le_o32 {dst}, {addr}")
        }
        
        RawInst::Vstore128LeO32 { addr,src, } => {
            let src = reg_name(**src);

            format!("vstore128le_o32 {addr}, {src}")
        }
        
        RawInst::VLoad128Z { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("vload128le_z {dst}, {addr}")
        }
        
        RawInst::Vstore128LeZ { addr,src, } => {
            let src = reg_name(**src);

            format!("vstore128le_z {addr}, {src}")
        }
        
        RawInst::VLoad128G32 { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("vload128le_g32 {dst}, {addr}")
        }
        
        RawInst::Vstore128LeG32 { addr,src, } => {
            let src = reg_name(**src);

            format!("vstore128le_g32 {addr}, {src}")
        }
        
        RawInst::Fmov { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fmov {dst}, {src}")
        }
        
        RawInst::Vmov { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vmov {dst}, {src}")
        }
        
        RawInst::BitcastIntFromFloat32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("bitcast_int_from_float_32 {dst}, {src}")
        }
        
        RawInst::BitcastIntFromFloat64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("bitcast_int_from_float_64 {dst}, {src}")
        }
        
        RawInst::BitcastFloatFromInt32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("bitcast_float_from_int_32 {dst}, {src}")
        }
        
        RawInst::BitcastFloatFromInt64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("bitcast_float_from_int_64 {dst}, {src}")
        }
        
        RawInst::FConst32 { dst,bits, } => {
            let dst = reg_name(*dst.to_reg());

            format!("fconst32 {dst}, {bits}")
        }
        
        RawInst::FConst64 { dst,bits, } => {
            let dst = reg_name(*dst.to_reg());

            format!("fconst64 {dst}, {bits}")
        }
        
        RawInst::Feq32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("feq32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fneq32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fneq32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Flt32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("flt32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Flteq32 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("flteq32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Feq64 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("feq64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fneq64 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fneq64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Flt64 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("flt64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Flteq64 { dst,src1,src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("flteq64 {dst}, {src1}, {src2}")
        }
        
        RawInst::FSelect32 { dst,cond,if_nonzero,if_zero, } => {
            let dst = reg_name(*dst.to_reg());
let cond = reg_name(**cond);
let if_nonzero = reg_name(**if_nonzero);
let if_zero = reg_name(**if_zero);

            format!("fselect32 {dst}, {cond}, {if_nonzero}, {if_zero}")
        }
        
        RawInst::FSelect64 { dst,cond,if_nonzero,if_zero, } => {
            let dst = reg_name(*dst.to_reg());
let cond = reg_name(**cond);
let if_nonzero = reg_name(**if_nonzero);
let if_zero = reg_name(**if_zero);

            format!("fselect64 {dst}, {cond}, {if_nonzero}, {if_zero}")
        }
        
        RawInst::F32FromF64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("f32_from_f64 {dst}, {src}")
        }
        
        RawInst::F64FromF32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("f64_from_f32 {dst}, {src}")
        }
        
        RawInst::F32FromX32S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("f32_from_x32_s {dst}, {src}")
        }
        
        RawInst::F32FromX32U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("f32_from_x32_u {dst}, {src}")
        }
        
        RawInst::F32FromX64S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("f32_from_x64_s {dst}, {src}")
        }
        
        RawInst::F32FromX64U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("f32_from_x64_u {dst}, {src}")
        }
        
        RawInst::F64FromX32S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("f64_from_x32_s {dst}, {src}")
        }
        
        RawInst::F64FromX32U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("f64_from_x32_u {dst}, {src}")
        }
        
        RawInst::F64FromX64S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("f64_from_x64_s {dst}, {src}")
        }
        
        RawInst::F64FromX64U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("f64_from_x64_u {dst}, {src}")
        }
        
        RawInst::X32FromF32S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x32_from_f32_s {dst}, {src}")
        }
        
        RawInst::X32FromF32U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x32_from_f32_u {dst}, {src}")
        }
        
        RawInst::X32FromF64S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x32_from_f64_s {dst}, {src}")
        }
        
        RawInst::X32FromF64U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x32_from_f64_u {dst}, {src}")
        }
        
        RawInst::X64FromF32S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x64_from_f32_s {dst}, {src}")
        }
        
        RawInst::X64FromF32U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x64_from_f32_u {dst}, {src}")
        }
        
        RawInst::X64FromF64S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x64_from_f64_s {dst}, {src}")
        }
        
        RawInst::X64FromF64U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x64_from_f64_u {dst}, {src}")
        }
        
        RawInst::X32FromF32SSat { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x32_from_f32_s_sat {dst}, {src}")
        }
        
        RawInst::X32FromF32USat { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x32_from_f32_u_sat {dst}, {src}")
        }
        
        RawInst::X32FromF64SSat { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x32_from_f64_s_sat {dst}, {src}")
        }
        
        RawInst::X32FromF64USat { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x32_from_f64_u_sat {dst}, {src}")
        }
        
        RawInst::X64FromF32SSat { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x64_from_f32_s_sat {dst}, {src}")
        }
        
        RawInst::X64FromF32USat { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x64_from_f32_u_sat {dst}, {src}")
        }
        
        RawInst::X64FromF64SSat { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x64_from_f64_s_sat {dst}, {src}")
        }
        
        RawInst::X64FromF64USat { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("x64_from_f64_u_sat {dst}, {src}")
        }
        
        RawInst::FCopySign32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fcopysign32 {dst}, {src1}, {src2}")
        }
        
        RawInst::FCopySign64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fcopysign64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fadd32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fadd32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fsub32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fsub32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vsubf32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vsubf32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fmul32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fmul32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmulf32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmulf32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fdiv32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fdiv32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vdivf32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vdivf32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fmaximum32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fmaximum32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fminimum32 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fminimum32 {dst}, {src1}, {src2}")
        }
        
        RawInst::Ftrunc32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("ftrunc32 {dst}, {src}")
        }
        
        RawInst::Vtrunc32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vtrunc32x4 {dst}, {src}")
        }
        
        RawInst::Vtrunc64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vtrunc64x2 {dst}, {src}")
        }
        
        RawInst::Ffloor32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("ffloor32 {dst}, {src}")
        }
        
        RawInst::Vfloor32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vfloor32x4 {dst}, {src}")
        }
        
        RawInst::Vfloor64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vfloor64x2 {dst}, {src}")
        }
        
        RawInst::Fceil32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fceil32 {dst}, {src}")
        }
        
        RawInst::Vceil32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vceil32x4 {dst}, {src}")
        }
        
        RawInst::Vceil64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vceil64x2 {dst}, {src}")
        }
        
        RawInst::Fnearest32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fnearest32 {dst}, {src}")
        }
        
        RawInst::Fsqrt32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fsqrt32 {dst}, {src}")
        }
        
        RawInst::Vsqrt32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vsqrt32x4 {dst}, {src}")
        }
        
        RawInst::Vsqrt64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vsqrt64x2 {dst}, {src}")
        }
        
        RawInst::Fneg32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fneg32 {dst}, {src}")
        }
        
        RawInst::Vnegf32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vnegf32x4 {dst}, {src}")
        }
        
        RawInst::Fabs32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fabs32 {dst}, {src}")
        }
        
        RawInst::Fadd64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fadd64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fsub64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fsub64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fmul64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fmul64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fdiv64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fdiv64 {dst}, {src1}, {src2}")
        }
        
        RawInst::VDivF64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vdivf64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fmaximum64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fmaximum64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Fminimum64 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("fminimum64 {dst}, {src1}, {src2}")
        }
        
        RawInst::Ftrunc64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("ftrunc64 {dst}, {src}")
        }
        
        RawInst::Ffloor64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("ffloor64 {dst}, {src}")
        }
        
        RawInst::Fceil64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fceil64 {dst}, {src}")
        }
        
        RawInst::Fnearest64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fnearest64 {dst}, {src}")
        }
        
        RawInst::Vnearest32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vnearest32x4 {dst}, {src}")
        }
        
        RawInst::Vnearest64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vnearest64x2 {dst}, {src}")
        }
        
        RawInst::Fsqrt64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fsqrt64 {dst}, {src}")
        }
        
        RawInst::Fneg64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fneg64 {dst}, {src}")
        }
        
        RawInst::Fabs64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fabs64 {dst}, {src}")
        }
        
        RawInst::Vconst128 { dst,imm, } => {
            let dst = reg_name(*dst.to_reg());

            format!("vconst128 {dst}, {imm}")
        }
        
        RawInst::VAddI8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddi8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddI16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddi16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddI32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddi32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddI64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddi64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddF32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddf32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddF64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddf64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddI8x16Sat { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddi8x16_sat {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddU8x16Sat { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddu8x16_sat {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddI16x8Sat { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddi16x8_sat {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddU16x8Sat { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddu16x8_sat {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddpairwiseI16x8S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddpairwisei16x8_s {dst}, {src1}, {src2}")
        }
        
        RawInst::VAddpairwiseI32x4S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vaddpairwisei32x4_s {dst}, {src1}, {src2}")
        }
        
        RawInst::VShlI8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshli8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::VShlI16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshli16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::VShlI32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshli32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::VShlI64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshli64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VShrI8x16S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshri8x16_s {dst}, {src1}, {src2}")
        }
        
        RawInst::VShrI16x8S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshri16x8_s {dst}, {src1}, {src2}")
        }
        
        RawInst::VShrI32x4S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshri32x4_s {dst}, {src1}, {src2}")
        }
        
        RawInst::VShrI64x2S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshri64x2_s {dst}, {src1}, {src2}")
        }
        
        RawInst::VShrI8x16U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshri8x16_u {dst}, {src1}, {src2}")
        }
        
        RawInst::VShrI16x8U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshri16x8_u {dst}, {src1}, {src2}")
        }
        
        RawInst::VShrI32x4U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshri32x4_u {dst}, {src1}, {src2}")
        }
        
        RawInst::VShrI64x2U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshri64x2_u {dst}, {src1}, {src2}")
        }
        
        RawInst::VSplatX8 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vsplatx8 {dst}, {src}")
        }
        
        RawInst::VSplatX16 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vsplatx16 {dst}, {src}")
        }
        
        RawInst::VSplatX32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vsplatx32 {dst}, {src}")
        }
        
        RawInst::VSplatX64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vsplatx64 {dst}, {src}")
        }
        
        RawInst::VSplatF32 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vsplatf32 {dst}, {src}")
        }
        
        RawInst::VSplatF64 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vsplatf64 {dst}, {src}")
        }
        
        RawInst::VLoad8x8SZ { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("vload8x8_s_z {dst}, {addr}")
        }
        
        RawInst::VLoad8x8UZ { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("vload8x8_u_z {dst}, {addr}")
        }
        
        RawInst::VLoad16x4LeSZ { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("vload16x4le_s_z {dst}, {addr}")
        }
        
        RawInst::VLoad16x4LeUZ { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("vload16x4le_u_z {dst}, {addr}")
        }
        
        RawInst::VLoad32x2LeSZ { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("vload32x2le_s_z {dst}, {addr}")
        }
        
        RawInst::VLoad32x2LeUZ { dst,addr, } => {
            let dst = reg_name(*dst.to_reg());

            format!("vload32x2le_u_z {dst}, {addr}")
        }
        
        RawInst::VBand128 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vband128 {dst}, {src1}, {src2}")
        }
        
        RawInst::VBor128 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vbor128 {dst}, {src1}, {src2}")
        }
        
        RawInst::VBxor128 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vbxor128 {dst}, {src1}, {src2}")
        }
        
        RawInst::VBnot128 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vbnot128 {dst}, {src}")
        }
        
        RawInst::VBitselect128 { dst,c,x,y, } => {
            let dst = reg_name(*dst.to_reg());
let c = reg_name(**c);
let x = reg_name(**x);
let y = reg_name(**y);

            format!("vbitselect128 {dst}, {c}, {x}, {y}")
        }
        
        RawInst::Vbitmask8x16 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vbitmask8x16 {dst}, {src}")
        }
        
        RawInst::Vbitmask16x8 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vbitmask16x8 {dst}, {src}")
        }
        
        RawInst::Vbitmask32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vbitmask32x4 {dst}, {src}")
        }
        
        RawInst::Vbitmask64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vbitmask64x2 {dst}, {src}")
        }
        
        RawInst::Valltrue8x16 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("valltrue8x16 {dst}, {src}")
        }
        
        RawInst::Valltrue16x8 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("valltrue16x8 {dst}, {src}")
        }
        
        RawInst::Valltrue32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("valltrue32x4 {dst}, {src}")
        }
        
        RawInst::Valltrue64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("valltrue64x2 {dst}, {src}")
        }
        
        RawInst::Vanytrue8x16 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vanytrue8x16 {dst}, {src}")
        }
        
        RawInst::Vanytrue16x8 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vanytrue16x8 {dst}, {src}")
        }
        
        RawInst::Vanytrue32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vanytrue32x4 {dst}, {src}")
        }
        
        RawInst::Vanytrue64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vanytrue64x2 {dst}, {src}")
        }
        
        RawInst::VF32x4FromI32x4S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vf32x4_from_i32x4_s {dst}, {src}")
        }
        
        RawInst::VF32x4FromI32x4U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vf32x4_from_i32x4_u {dst}, {src}")
        }
        
        RawInst::VF64x2FromI64x2S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vf64x2_from_i64x2_s {dst}, {src}")
        }
        
        RawInst::VF64x2FromI64x2U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vf64x2_from_i64x2_u {dst}, {src}")
        }
        
        RawInst::VI32x4FromF32x4S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vi32x4_from_f32x4_s {dst}, {src}")
        }
        
        RawInst::VI32x4FromF32x4U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vi32x4_from_f32x4_u {dst}, {src}")
        }
        
        RawInst::VI64x2FromF64x2S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vi64x2_from_f64x2_s {dst}, {src}")
        }
        
        RawInst::VI64x2FromF64x2U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vi64x2_from_f64x2_u {dst}, {src}")
        }
        
        RawInst::VWidenLow8x16S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenlow8x16_s {dst}, {src}")
        }
        
        RawInst::VWidenLow8x16U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenlow8x16_u {dst}, {src}")
        }
        
        RawInst::VWidenLow16x8S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenlow16x8_s {dst}, {src}")
        }
        
        RawInst::VWidenLow16x8U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenlow16x8_u {dst}, {src}")
        }
        
        RawInst::VWidenLow32x4S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenlow32x4_s {dst}, {src}")
        }
        
        RawInst::VWidenLow32x4U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenlow32x4_u {dst}, {src}")
        }
        
        RawInst::VWidenHigh8x16S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenhigh8x16_s {dst}, {src}")
        }
        
        RawInst::VWidenHigh8x16U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenhigh8x16_u {dst}, {src}")
        }
        
        RawInst::VWidenHigh16x8S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenhigh16x8_s {dst}, {src}")
        }
        
        RawInst::VWidenHigh16x8U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenhigh16x8_u {dst}, {src}")
        }
        
        RawInst::VWidenHigh32x4S { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenhigh32x4_s {dst}, {src}")
        }
        
        RawInst::VWidenHigh32x4U { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vwidenhigh32x4_u {dst}, {src}")
        }
        
        RawInst::Vnarrow16x8S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vnarrow16x8_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Vnarrow16x8U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vnarrow16x8_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Vnarrow32x4S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vnarrow32x4_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Vnarrow32x4U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vnarrow32x4_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Vnarrow64x2S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vnarrow64x2_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Vnarrow64x2U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vnarrow64x2_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Vunarrow64x2U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vunarrow64x2_u {dst}, {src1}, {src2}")
        }
        
        RawInst::VFpromoteLow { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vfpromotelow {dst}, {src}")
        }
        
        RawInst::VFdemote { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vfdemote {dst}, {src}")
        }
        
        RawInst::VSubI8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vsubi8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::VSubI16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vsubi16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::VSubI32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vsubi32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::VSubI64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vsubi64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VSubF64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vsubf64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VSubI8x16Sat { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vsubi8x16_sat {dst}, {src1}, {src2}")
        }
        
        RawInst::VSubU8x16Sat { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vsubu8x16_sat {dst}, {src1}, {src2}")
        }
        
        RawInst::VSubI16x8Sat { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vsubi16x8_sat {dst}, {src1}, {src2}")
        }
        
        RawInst::VSubU16x8Sat { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vsubu16x8_sat {dst}, {src1}, {src2}")
        }
        
        RawInst::VMulI8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmuli8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::VMulI16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmuli16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::VMulI32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmuli32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::VMulI64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmuli64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VMulF64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmulf64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VQmulrsI16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vqmulrsi16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::VPopcnt8x16 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vpopcnt8x16 {dst}, {src}")
        }
        
        RawInst::XExtractV8x16 { dst,src,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xextractv8x16 {dst}, {src}, {lane}")
        }
        
        RawInst::XExtractV16x8 { dst,src,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xextractv16x8 {dst}, {src}, {lane}")
        }
        
        RawInst::XExtractV32x4 { dst,src,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xextractv32x4 {dst}, {src}, {lane}")
        }
        
        RawInst::XExtractV64x2 { dst,src,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("xextractv64x2 {dst}, {src}, {lane}")
        }
        
        RawInst::FExtractV32x4 { dst,src,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fextractv32x4 {dst}, {src}, {lane}")
        }
        
        RawInst::FExtractV64x2 { dst,src,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("fextractv64x2 {dst}, {src}, {lane}")
        }
        
        RawInst::VInsertX8 { dst, src1, src2,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vinsertx8 {dst}, {src1}, {src2}, {lane}")
        }
        
        RawInst::VInsertX16 { dst, src1, src2,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vinsertx16 {dst}, {src1}, {src2}, {lane}")
        }
        
        RawInst::VInsertX32 { dst, src1, src2,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vinsertx32 {dst}, {src1}, {src2}, {lane}")
        }
        
        RawInst::VInsertX64 { dst, src1, src2,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vinsertx64 {dst}, {src1}, {src2}, {lane}")
        }
        
        RawInst::VInsertF32 { dst, src1, src2,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vinsertf32 {dst}, {src1}, {src2}, {lane}")
        }
        
        RawInst::VInsertF64 { dst, src1, src2,lane, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vinsertf64 {dst}, {src1}, {src2}, {lane}")
        }
        
        RawInst::Veq8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("veq8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vneq8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vneq8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vslt8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vslt8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vslteq8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vslteq8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vult8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vult8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vulteq8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vulteq8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::Veq16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("veq16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vneq16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vneq16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vslt16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vslt16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vslteq16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vslteq16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vult16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vult16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vulteq16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vulteq16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::Veq32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("veq32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vneq32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vneq32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vslt32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vslt32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vslteq32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vslteq32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vult32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vult32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vulteq32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vulteq32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Veq64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("veq64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vneq64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vneq64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vslt64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vslt64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vslteq64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vslteq64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vult64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vult64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vulteq64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vulteq64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vneg8x16 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vneg8x16 {dst}, {src}")
        }
        
        RawInst::Vneg16x8 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vneg16x8 {dst}, {src}")
        }
        
        RawInst::Vneg32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vneg32x4 {dst}, {src}")
        }
        
        RawInst::Vneg64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vneg64x2 {dst}, {src}")
        }
        
        RawInst::VnegF64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vnegf64x2 {dst}, {src}")
        }
        
        RawInst::Vmin8x16S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmin8x16_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmin8x16U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmin8x16_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmin16x8S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmin16x8_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmin16x8U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmin16x8_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmax8x16S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmax8x16_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmax8x16U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmax8x16_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmax16x8S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmax16x8_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmax16x8U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmax16x8_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmin32x4S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmin32x4_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmin32x4U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmin32x4_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmax32x4S { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmax32x4_s {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmax32x4U { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmax32x4_u {dst}, {src1}, {src2}")
        }
        
        RawInst::Vabs8x16 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vabs8x16 {dst}, {src}")
        }
        
        RawInst::Vabs16x8 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vabs16x8 {dst}, {src}")
        }
        
        RawInst::Vabs32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vabs32x4 {dst}, {src}")
        }
        
        RawInst::Vabs64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vabs64x2 {dst}, {src}")
        }
        
        RawInst::Vabsf32x4 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vabsf32x4 {dst}, {src}")
        }
        
        RawInst::Vabsf64x2 { dst,src, } => {
            let dst = reg_name(*dst.to_reg());
let src = reg_name(**src);

            format!("vabsf64x2 {dst}, {src}")
        }
        
        RawInst::Vmaximumf32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmaximumf32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vmaximumf64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vmaximumf64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vminimumf32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vminimumf32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vminimumf64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vminimumf64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VShuffle { dst,src1,src2,mask, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vshuffle {dst}, {src1}, {src2}, {mask}")
        }
        
        RawInst::Vswizzlei8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vswizzlei8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vavground8x16 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vavground8x16 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vavground16x8 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vavground16x8 {dst}, {src1}, {src2}")
        }
        
        RawInst::VeqF32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("veqf32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::VneqF32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vneqf32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::VltF32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vltf32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::VlteqF32x4 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vlteqf32x4 {dst}, {src1}, {src2}")
        }
        
        RawInst::VeqF64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("veqf64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VneqF64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vneqf64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VltF64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vltf64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::VlteqF64x2 { dst, src1, src2, } => {
            let dst = reg_name(*dst.to_reg());
let src1 = reg_name(**src1);
let src2 = reg_name(**src2);

            format!("vlteqf64x2 {dst}, {src1}, {src2}")
        }
        
        RawInst::Vfma32x4 { dst,a,b,c, } => {
            let dst = reg_name(*dst.to_reg());
let a = reg_name(**a);
let b = reg_name(**b);
let c = reg_name(**c);

            format!("vfma32x4 {dst}, {a}, {b}, {c}")
        }
        
        RawInst::Vfma64x2 { dst,a,b,c, } => {
            let dst = reg_name(*dst.to_reg());
let a = reg_name(**a);
let b = reg_name(**b);
let c = reg_name(**c);

            format!("vfma64x2 {dst}, {a}, {b}, {c}")
        }
        
        RawInst::Vselect { dst,cond,if_nonzero,if_zero, } => {
            let dst = reg_name(*dst.to_reg());
let cond = reg_name(**cond);
let if_nonzero = reg_name(**if_nonzero);
let if_zero = reg_name(**if_zero);

            format!("vselect {dst}, {cond}, {if_nonzero}, {if_zero}")
        }
        
        RawInst::Xadd128 { dst_lo,dst_hi,lhs_lo,lhs_hi,rhs_lo,rhs_hi, } => {
            let dst_lo = reg_name(*dst_lo.to_reg());
let dst_hi = reg_name(*dst_hi.to_reg());
let lhs_lo = reg_name(**lhs_lo);
let lhs_hi = reg_name(**lhs_hi);
let rhs_lo = reg_name(**rhs_lo);
let rhs_hi = reg_name(**rhs_hi);

            format!("xadd128 {dst_lo}, {dst_hi}, {lhs_lo}, {lhs_hi}, {rhs_lo}, {rhs_hi}")
        }
        
        RawInst::Xsub128 { dst_lo,dst_hi,lhs_lo,lhs_hi,rhs_lo,rhs_hi, } => {
            let dst_lo = reg_name(*dst_lo.to_reg());
let dst_hi = reg_name(*dst_hi.to_reg());
let lhs_lo = reg_name(**lhs_lo);
let lhs_hi = reg_name(**lhs_hi);
let rhs_lo = reg_name(**rhs_lo);
let rhs_hi = reg_name(**rhs_hi);

            format!("xsub128 {dst_lo}, {dst_hi}, {lhs_lo}, {lhs_hi}, {rhs_lo}, {rhs_hi}")
        }
        
        RawInst::Xwidemul64S { dst_lo,dst_hi,lhs,rhs, } => {
            let dst_lo = reg_name(*dst_lo.to_reg());
let dst_hi = reg_name(*dst_hi.to_reg());
let lhs = reg_name(**lhs);
let rhs = reg_name(**rhs);

            format!("xwidemul64_s {dst_lo}, {dst_hi}, {lhs}, {rhs}")
        }
        
        RawInst::Xwidemul64U { dst_lo,dst_hi,lhs,rhs, } => {
            let dst_lo = reg_name(*dst_lo.to_reg());
let dst_hi = reg_name(*dst_hi.to_reg());
let lhs = reg_name(**lhs);
let rhs = reg_name(**rhs);

            format!("xwidemul64_u {dst_lo}, {dst_hi}, {lhs}, {rhs}")
        }
        }
}
pub fn get_operands(inst: &mut RawInst, collector: &mut impl OperandVisitor) {
match inst {

        RawInst::Nop {  .. } => {
            
            
            
        }
        
        RawInst::Ret {  .. } => {
            
            
            
        }
        
        RawInst::XJump { reg, .. } => {
            collector.reg_use(reg);

            
            
        }
        
        RawInst::Xmov { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xzero { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::Xone { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::Xconst8 { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::Xconst16 { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::Xconst32 { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::Xconst64 { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::Xadd32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xadd32U8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xadd32U32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xadd64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xadd64U8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xadd64U32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmadd32 { dst,src1,src2,src3, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);
collector.reg_use(src3);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmadd64 { dst,src1,src2,src3, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);
collector.reg_use(src3);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xsub32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xsub32U8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xsub32U32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xsub64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xsub64U8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xsub64U32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::XMul32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmul32S8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmul32S32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::XMul64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmul64S8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmul64S32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xctz32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xctz64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xclz32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xclz64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xpopcnt32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xpopcnt64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xrotl32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xrotl64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xrotr32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xrotr64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshl32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshr32S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshr32U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshl64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshr64S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshr64U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshl32U6 { dst, src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshr32SU6 { dst, src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshr32UU6 { dst, src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshl64U6 { dst, src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshr64SU6 { dst, src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xshr64UU6 { dst, src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xneg32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xneg64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xeq64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xneq64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xslt64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xslteq64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xult64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xulteq64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xeq32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xneq32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xslt32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xslteq32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xult32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xulteq32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XLoad8U32O32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad8S32O32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad16LeU32O32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad16LeS32O32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad32LeO32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad64LeO32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XStore8O32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore16LeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore32LeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore64LeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XLoad8U32Z { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad8S32Z { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad16LeU32Z { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad16LeS32Z { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad32LeZ { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad64LeZ { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XStore8Z { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore16LeZ { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore32LeZ { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore64LeZ { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XLoad8U32G32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad8S32G32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad16LeU32G32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad16LeS32G32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad32LeG32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad64LeG32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XStore8G32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore16LeG32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore32LeG32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore64LeG32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XLoad8U32G32Bne { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad8S32G32Bne { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad16LeU32G32Bne { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad16LeS32G32Bne { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad32LeG32Bne { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad64LeG32Bne { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XStore8G32Bne { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore16LeG32Bne { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore32LeG32Bne { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore64LeG32Bne { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::PushFrame {  .. } => {
            
            
            
        }
        
        RawInst::PopFrame {  .. } => {
            
            
            
        }
        
        RawInst::PushFrameSave {  .. } => {
            
            
            
        }
        
        RawInst::PopFrameRestore {  .. } => {
            
            
            
        }
        
        RawInst::StackAlloc32 {  .. } => {
            
            
            
        }
        
        RawInst::StackFree32 {  .. } => {
            
            
            
        }
        
        RawInst::Zext8 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Zext16 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Zext32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Sext8 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Sext16 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Sext32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::XAbs32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::XAbs64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::XDiv32S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XDiv64S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XDiv32U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XDiv64U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XRem32S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XRem64S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XRem32U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XRem64U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XBand32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xband32S8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xband32S32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::XBand64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xband64S8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xband64S32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::XBor32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xbor32S8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xbor32S32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::XBor64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xbor64S8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xbor64S32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::XBxor32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xbxor32S8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xbxor32S32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::XBxor64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xbxor64S8 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xbxor64S32 { dst,src1, .. } => {
            collector.reg_use(src1);

            collector.reg_def(dst);

            
        }
        
        RawInst::XBnot32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::XBnot64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmin32U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmin32S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmax32U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmax32S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmin64U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmin64S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmax64U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xmax64S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XSelect32 { dst,cond,if_nonzero,if_zero, .. } => {
            collector.reg_use(cond);
collector.reg_use(if_nonzero);
collector.reg_use(if_zero);

            collector.reg_def(dst);

            
        }
        
        RawInst::XSelect64 { dst,cond,if_nonzero,if_zero, .. } => {
            collector.reg_use(cond);
collector.reg_use(if_nonzero);
collector.reg_use(if_zero);

            collector.reg_def(dst);

            
        }
        
        RawInst::Trap {  .. } => {
            
            
            
        }
        
        RawInst::Xpcadd { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::XmovFp { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::XmovLr { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::Bswap32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Bswap64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xadd32UoverflowTrap { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xadd64UoverflowTrap { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XMulHi64S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::XMulHi64U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xbmask32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xbmask64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::XLoad16BeU32O32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad16BeS32O32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad32BeO32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XLoad64BeO32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::XStore16BeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore32BeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::XStore64BeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::Fload32BeO32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Fload64BeO32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Fstore32BeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::Fstore64BeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::Fload32LeO32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Fload64LeO32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Fstore32LeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::Fstore64LeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::Fload32LeZ { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Fload64LeZ { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Fstore32LeZ { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::Fstore64LeZ { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::Fload32LeG32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Fload64LeG32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Fstore32LeG32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::Fstore64LeG32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::VLoad128O32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Vstore128LeO32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::VLoad128Z { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Vstore128LeZ { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::VLoad128G32 { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::Vstore128LeG32 { addr,src, .. } => {
            collector.reg_use(src);

            
            addr.collect_operands(collector);

        }
        
        RawInst::Fmov { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmov { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::BitcastIntFromFloat32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::BitcastIntFromFloat64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::BitcastFloatFromInt32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::BitcastFloatFromInt64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::FConst32 { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::FConst64 { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::Feq32 { dst,src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fneq32 { dst,src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Flt32 { dst,src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Flteq32 { dst,src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Feq64 { dst,src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fneq64 { dst,src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Flt64 { dst,src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Flteq64 { dst,src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::FSelect32 { dst,cond,if_nonzero,if_zero, .. } => {
            collector.reg_use(cond);
collector.reg_use(if_nonzero);
collector.reg_use(if_zero);

            collector.reg_def(dst);

            
        }
        
        RawInst::FSelect64 { dst,cond,if_nonzero,if_zero, .. } => {
            collector.reg_use(cond);
collector.reg_use(if_nonzero);
collector.reg_use(if_zero);

            collector.reg_def(dst);

            
        }
        
        RawInst::F32FromF64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::F64FromF32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::F32FromX32S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::F32FromX32U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::F32FromX64S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::F32FromX64U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::F64FromX32S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::F64FromX32U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::F64FromX64S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::F64FromX64U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X32FromF32S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X32FromF32U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X32FromF64S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X32FromF64U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X64FromF32S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X64FromF32U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X64FromF64S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X64FromF64U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X32FromF32SSat { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X32FromF32USat { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X32FromF64SSat { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X32FromF64USat { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X64FromF32SSat { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X64FromF32USat { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X64FromF64SSat { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::X64FromF64USat { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::FCopySign32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::FCopySign64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fadd32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fsub32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vsubf32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fmul32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmulf32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fdiv32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vdivf32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fmaximum32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fminimum32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Ftrunc32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vtrunc32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vtrunc64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Ffloor32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vfloor32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vfloor64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fceil32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vceil32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vceil64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fnearest32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fsqrt32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vsqrt32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vsqrt64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fneg32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vnegf32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fabs32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fadd64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fsub64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fmul64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fdiv64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VDivF64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fmaximum64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fminimum64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Ftrunc64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Ffloor64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fceil64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fnearest64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vnearest32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vnearest64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fsqrt64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fneg64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Fabs64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vconst128 { dst, .. } => {
            
            collector.reg_def(dst);

            
        }
        
        RawInst::VAddI8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddI16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddI32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddI64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddF32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddF64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddI8x16Sat { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddU8x16Sat { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddI16x8Sat { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddU16x8Sat { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddpairwiseI16x8S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VAddpairwiseI32x4S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShlI8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShlI16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShlI32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShlI64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShrI8x16S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShrI16x8S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShrI32x4S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShrI64x2S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShrI8x16U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShrI16x8U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShrI32x4U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShrI64x2U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSplatX8 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSplatX16 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSplatX32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSplatX64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSplatF32 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSplatF64 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VLoad8x8SZ { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::VLoad8x8UZ { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::VLoad16x4LeSZ { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::VLoad16x4LeUZ { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::VLoad32x2LeSZ { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::VLoad32x2LeUZ { dst,addr, .. } => {
            
            collector.reg_def(dst);

            addr.collect_operands(collector);

        }
        
        RawInst::VBand128 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VBor128 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VBxor128 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VBnot128 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VBitselect128 { dst,c,x,y, .. } => {
            collector.reg_use(c);
collector.reg_use(x);
collector.reg_use(y);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vbitmask8x16 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vbitmask16x8 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vbitmask32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vbitmask64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Valltrue8x16 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Valltrue16x8 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Valltrue32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Valltrue64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vanytrue8x16 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vanytrue16x8 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vanytrue32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vanytrue64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VF32x4FromI32x4S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VF32x4FromI32x4U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VF64x2FromI64x2S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VF64x2FromI64x2U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VI32x4FromF32x4S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VI32x4FromF32x4U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VI64x2FromF64x2S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VI64x2FromF64x2U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenLow8x16S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenLow8x16U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenLow16x8S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenLow16x8U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenLow32x4S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenLow32x4U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenHigh8x16S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenHigh8x16U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenHigh16x8S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenHigh16x8U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenHigh32x4S { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VWidenHigh32x4U { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vnarrow16x8S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vnarrow16x8U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vnarrow32x4S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vnarrow32x4U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vnarrow64x2S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vnarrow64x2U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vunarrow64x2U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VFpromoteLow { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VFdemote { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSubI8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSubI16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSubI32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSubI64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSubF64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSubI8x16Sat { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSubU8x16Sat { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSubI16x8Sat { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VSubU16x8Sat { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VMulI8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VMulI16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VMulI32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VMulI64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VMulF64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VQmulrsI16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VPopcnt8x16 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::XExtractV8x16 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::XExtractV16x8 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::XExtractV32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::XExtractV64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::FExtractV32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::FExtractV64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VInsertX8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VInsertX16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VInsertX32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VInsertX64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VInsertF32 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VInsertF64 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Veq8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vneq8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vslt8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vslteq8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vult8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vulteq8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Veq16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vneq16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vslt16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vslteq16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vult16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vulteq16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Veq32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vneq32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vslt32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vslteq32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vult32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vulteq32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Veq64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vneq64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vslt64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vslteq64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vult64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vulteq64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vneg8x16 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vneg16x8 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vneg32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vneg64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::VnegF64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmin8x16S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmin8x16U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmin16x8S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmin16x8U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmax8x16S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmax8x16U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmax16x8S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmax16x8U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmin32x4S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmin32x4U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmax32x4S { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmax32x4U { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vabs8x16 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vabs16x8 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vabs32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vabs64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vabsf32x4 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vabsf64x2 { dst,src, .. } => {
            collector.reg_use(src);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmaximumf32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vmaximumf64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vminimumf32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vminimumf64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VShuffle { dst,src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vswizzlei8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vavground8x16 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vavground16x8 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VeqF32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VneqF32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VltF32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VlteqF32x4 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VeqF64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VneqF64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VltF64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::VlteqF64x2 { dst, src1,src2, .. } => {
            collector.reg_use(src1);
collector.reg_use(src2);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vfma32x4 { dst,a,b,c, .. } => {
            collector.reg_use(a);
collector.reg_use(b);
collector.reg_use(c);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vfma64x2 { dst,a,b,c, .. } => {
            collector.reg_use(a);
collector.reg_use(b);
collector.reg_use(c);

            collector.reg_def(dst);

            
        }
        
        RawInst::Vselect { dst,cond,if_nonzero,if_zero, .. } => {
            collector.reg_use(cond);
collector.reg_use(if_nonzero);
collector.reg_use(if_zero);

            collector.reg_def(dst);

            
        }
        
        RawInst::Xadd128 { dst_lo,dst_hi,lhs_lo,lhs_hi,rhs_lo,rhs_hi, .. } => {
            collector.reg_use(lhs_lo);
collector.reg_use(lhs_hi);
collector.reg_use(rhs_lo);
collector.reg_use(rhs_hi);

            collector.reg_def(dst_lo);
collector.reg_def(dst_hi);

            
        }
        
        RawInst::Xsub128 { dst_lo,dst_hi,lhs_lo,lhs_hi,rhs_lo,rhs_hi, .. } => {
            collector.reg_use(lhs_lo);
collector.reg_use(lhs_hi);
collector.reg_use(rhs_lo);
collector.reg_use(rhs_hi);

            collector.reg_def(dst_lo);
collector.reg_def(dst_hi);

            
        }
        
        RawInst::Xwidemul64S { dst_lo,dst_hi,lhs,rhs, .. } => {
            collector.reg_use(lhs);
collector.reg_use(rhs);

            collector.reg_def(dst_lo);
collector.reg_def(dst_hi);

            
        }
        
        RawInst::Xwidemul64U { dst_lo,dst_hi,lhs,rhs, .. } => {
            collector.reg_use(lhs);
collector.reg_use(rhs);

            collector.reg_def(dst_lo);
collector.reg_def(dst_hi);

            
        }
        }
}
pub fn emit<P>(inst: &RawInst, sink: &mut MachBuffer<InstAndKind<P>>)
  where P: PulleyTargetKind,
{
match *inst {

        RawInst::Nop {  } => {
            
            pulley_interpreter::encode::nop(sink, )
        }
        
        RawInst::Ret {  } => {
            
            pulley_interpreter::encode::ret(sink, )
        }
        
        RawInst::XJump { reg, } => {
            
            pulley_interpreter::encode::xjump(sink, reg,)
        }
        
        RawInst::Xmov { dst,src, } => {
            
            pulley_interpreter::encode::xmov(sink, dst,src,)
        }
        
        RawInst::Xzero { dst, } => {
            
            pulley_interpreter::encode::xzero(sink, dst,)
        }
        
        RawInst::Xone { dst, } => {
            
            pulley_interpreter::encode::xone(sink, dst,)
        }
        
        RawInst::Xconst8 { dst,imm, } => {
            
            pulley_interpreter::encode::xconst8(sink, dst,imm,)
        }
        
        RawInst::Xconst16 { dst,imm, } => {
            
            pulley_interpreter::encode::xconst16(sink, dst,imm,)
        }
        
        RawInst::Xconst32 { dst,imm, } => {
            
            pulley_interpreter::encode::xconst32(sink, dst,imm,)
        }
        
        RawInst::Xconst64 { dst,imm, } => {
            
            pulley_interpreter::encode::xconst64(sink, dst,imm,)
        }
        
        RawInst::Xadd32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xadd32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xadd32U8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xadd32_u8(sink, dst,src1,src2,)
        }
        
        RawInst::Xadd32U32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xadd32_u32(sink, dst,src1,src2,)
        }
        
        RawInst::Xadd64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xadd64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xadd64U8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xadd64_u8(sink, dst,src1,src2,)
        }
        
        RawInst::Xadd64U32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xadd64_u32(sink, dst,src1,src2,)
        }
        
        RawInst::Xmadd32 { dst,src1,src2,src3, } => {
            
            pulley_interpreter::encode::xmadd32(sink, dst,src1,src2,src3,)
        }
        
        RawInst::Xmadd64 { dst,src1,src2,src3, } => {
            
            pulley_interpreter::encode::xmadd64(sink, dst,src1,src2,src3,)
        }
        
        RawInst::Xsub32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xsub32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xsub32U8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xsub32_u8(sink, dst,src1,src2,)
        }
        
        RawInst::Xsub32U32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xsub32_u32(sink, dst,src1,src2,)
        }
        
        RawInst::Xsub64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xsub64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xsub64U8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xsub64_u8(sink, dst,src1,src2,)
        }
        
        RawInst::Xsub64U32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xsub64_u32(sink, dst,src1,src2,)
        }
        
        RawInst::XMul32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmul32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xmul32S8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xmul32_s8(sink, dst,src1,src2,)
        }
        
        RawInst::Xmul32S32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xmul32_s32(sink, dst,src1,src2,)
        }
        
        RawInst::XMul64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmul64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xmul64S8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xmul64_s8(sink, dst,src1,src2,)
        }
        
        RawInst::Xmul64S32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xmul64_s32(sink, dst,src1,src2,)
        }
        
        RawInst::Xctz32 { dst,src, } => {
            
            pulley_interpreter::encode::xctz32(sink, dst,src,)
        }
        
        RawInst::Xctz64 { dst,src, } => {
            
            pulley_interpreter::encode::xctz64(sink, dst,src,)
        }
        
        RawInst::Xclz32 { dst,src, } => {
            
            pulley_interpreter::encode::xclz32(sink, dst,src,)
        }
        
        RawInst::Xclz64 { dst,src, } => {
            
            pulley_interpreter::encode::xclz64(sink, dst,src,)
        }
        
        RawInst::Xpopcnt32 { dst,src, } => {
            
            pulley_interpreter::encode::xpopcnt32(sink, dst,src,)
        }
        
        RawInst::Xpopcnt64 { dst,src, } => {
            
            pulley_interpreter::encode::xpopcnt64(sink, dst,src,)
        }
        
        RawInst::Xrotl32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xrotl32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xrotl64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xrotl64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xrotr32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xrotr32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xrotr64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xrotr64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshl32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshl32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshr32S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshr32_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshr32U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshr32_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshl64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshl64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshr64S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshr64_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshr64U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshr64_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshl32U6 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshl32_u6(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshr32SU6 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshr32_s_u6(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshr32UU6 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshr32_u_u6(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshl64U6 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshl64_u6(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshr64SU6 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshr64_s_u6(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xshr64UU6 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xshr64_u_u6(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xneg32 { dst,src, } => {
            
            pulley_interpreter::encode::xneg32(sink, dst,src,)
        }
        
        RawInst::Xneg64 { dst,src, } => {
            
            pulley_interpreter::encode::xneg64(sink, dst,src,)
        }
        
        RawInst::Xeq64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xeq64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xneq64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xneq64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xslt64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xslt64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xslteq64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xslteq64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xult64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xult64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xulteq64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xulteq64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xeq32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xeq32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xneq32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xneq32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xslt32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xslt32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xslteq32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xslteq32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xult32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xult32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xulteq32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xulteq32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XLoad8U32O32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload8_u32_o32(sink, dst,addr,)
        }
        
        RawInst::XLoad8S32O32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload8_s32_o32(sink, dst,addr,)
        }
        
        RawInst::XLoad16LeU32O32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload16le_u32_o32(sink, dst,addr,)
        }
        
        RawInst::XLoad16LeS32O32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload16le_s32_o32(sink, dst,addr,)
        }
        
        RawInst::XLoad32LeO32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload32le_o32(sink, dst,addr,)
        }
        
        RawInst::XLoad64LeO32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload64le_o32(sink, dst,addr,)
        }
        
        RawInst::XStore8O32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore8_o32(sink, addr,src,)
        }
        
        RawInst::XStore16LeO32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore16le_o32(sink, addr,src,)
        }
        
        RawInst::XStore32LeO32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore32le_o32(sink, addr,src,)
        }
        
        RawInst::XStore64LeO32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore64le_o32(sink, addr,src,)
        }
        
        RawInst::XLoad8U32Z { dst,addr, } => {
            
            pulley_interpreter::encode::xload8_u32_z(sink, dst,addr,)
        }
        
        RawInst::XLoad8S32Z { dst,addr, } => {
            
            pulley_interpreter::encode::xload8_s32_z(sink, dst,addr,)
        }
        
        RawInst::XLoad16LeU32Z { dst,addr, } => {
            
            pulley_interpreter::encode::xload16le_u32_z(sink, dst,addr,)
        }
        
        RawInst::XLoad16LeS32Z { dst,addr, } => {
            
            pulley_interpreter::encode::xload16le_s32_z(sink, dst,addr,)
        }
        
        RawInst::XLoad32LeZ { dst,addr, } => {
            
            pulley_interpreter::encode::xload32le_z(sink, dst,addr,)
        }
        
        RawInst::XLoad64LeZ { dst,addr, } => {
            
            pulley_interpreter::encode::xload64le_z(sink, dst,addr,)
        }
        
        RawInst::XStore8Z { addr,src, } => {
            
            pulley_interpreter::encode::xstore8_z(sink, addr,src,)
        }
        
        RawInst::XStore16LeZ { addr,src, } => {
            
            pulley_interpreter::encode::xstore16le_z(sink, addr,src,)
        }
        
        RawInst::XStore32LeZ { addr,src, } => {
            
            pulley_interpreter::encode::xstore32le_z(sink, addr,src,)
        }
        
        RawInst::XStore64LeZ { addr,src, } => {
            
            pulley_interpreter::encode::xstore64le_z(sink, addr,src,)
        }
        
        RawInst::XLoad8U32G32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload8_u32_g32(sink, dst,addr,)
        }
        
        RawInst::XLoad8S32G32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload8_s32_g32(sink, dst,addr,)
        }
        
        RawInst::XLoad16LeU32G32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload16le_u32_g32(sink, dst,addr,)
        }
        
        RawInst::XLoad16LeS32G32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload16le_s32_g32(sink, dst,addr,)
        }
        
        RawInst::XLoad32LeG32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload32le_g32(sink, dst,addr,)
        }
        
        RawInst::XLoad64LeG32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload64le_g32(sink, dst,addr,)
        }
        
        RawInst::XStore8G32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore8_g32(sink, addr,src,)
        }
        
        RawInst::XStore16LeG32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore16le_g32(sink, addr,src,)
        }
        
        RawInst::XStore32LeG32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore32le_g32(sink, addr,src,)
        }
        
        RawInst::XStore64LeG32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore64le_g32(sink, addr,src,)
        }
        
        RawInst::XLoad8U32G32Bne { dst,addr, } => {
            
            pulley_interpreter::encode::xload8_u32_g32bne(sink, dst,addr,)
        }
        
        RawInst::XLoad8S32G32Bne { dst,addr, } => {
            
            pulley_interpreter::encode::xload8_s32_g32bne(sink, dst,addr,)
        }
        
        RawInst::XLoad16LeU32G32Bne { dst,addr, } => {
            
            pulley_interpreter::encode::xload16le_u32_g32bne(sink, dst,addr,)
        }
        
        RawInst::XLoad16LeS32G32Bne { dst,addr, } => {
            
            pulley_interpreter::encode::xload16le_s32_g32bne(sink, dst,addr,)
        }
        
        RawInst::XLoad32LeG32Bne { dst,addr, } => {
            
            pulley_interpreter::encode::xload32le_g32bne(sink, dst,addr,)
        }
        
        RawInst::XLoad64LeG32Bne { dst,addr, } => {
            
            pulley_interpreter::encode::xload64le_g32bne(sink, dst,addr,)
        }
        
        RawInst::XStore8G32Bne { addr,src, } => {
            
            pulley_interpreter::encode::xstore8_g32bne(sink, addr,src,)
        }
        
        RawInst::XStore16LeG32Bne { addr,src, } => {
            
            pulley_interpreter::encode::xstore16le_g32bne(sink, addr,src,)
        }
        
        RawInst::XStore32LeG32Bne { addr,src, } => {
            
            pulley_interpreter::encode::xstore32le_g32bne(sink, addr,src,)
        }
        
        RawInst::XStore64LeG32Bne { addr,src, } => {
            
            pulley_interpreter::encode::xstore64le_g32bne(sink, addr,src,)
        }
        
        RawInst::PushFrame {  } => {
            
            pulley_interpreter::encode::push_frame(sink, )
        }
        
        RawInst::PopFrame {  } => {
            
            pulley_interpreter::encode::pop_frame(sink, )
        }
        
        RawInst::PushFrameSave { amt,regs, } => {
            
            pulley_interpreter::encode::push_frame_save(sink, amt,regs,)
        }
        
        RawInst::PopFrameRestore { amt,regs, } => {
            
            pulley_interpreter::encode::pop_frame_restore(sink, amt,regs,)
        }
        
        RawInst::StackAlloc32 { amt, } => {
            
            pulley_interpreter::encode::stack_alloc32(sink, amt,)
        }
        
        RawInst::StackFree32 { amt, } => {
            
            pulley_interpreter::encode::stack_free32(sink, amt,)
        }
        
        RawInst::Zext8 { dst,src, } => {
            
            pulley_interpreter::encode::zext8(sink, dst,src,)
        }
        
        RawInst::Zext16 { dst,src, } => {
            
            pulley_interpreter::encode::zext16(sink, dst,src,)
        }
        
        RawInst::Zext32 { dst,src, } => {
            
            pulley_interpreter::encode::zext32(sink, dst,src,)
        }
        
        RawInst::Sext8 { dst,src, } => {
            
            pulley_interpreter::encode::sext8(sink, dst,src,)
        }
        
        RawInst::Sext16 { dst,src, } => {
            
            pulley_interpreter::encode::sext16(sink, dst,src,)
        }
        
        RawInst::Sext32 { dst,src, } => {
            
            pulley_interpreter::encode::sext32(sink, dst,src,)
        }
        
        RawInst::XAbs32 { dst,src, } => {
            
            pulley_interpreter::encode::xabs32(sink, dst,src,)
        }
        
        RawInst::XAbs64 { dst,src, } => {
            
            pulley_interpreter::encode::xabs64(sink, dst,src,)
        }
        
        RawInst::XDiv32S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xdiv32_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XDiv64S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xdiv64_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XDiv32U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xdiv32_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XDiv64U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xdiv64_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XRem32S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xrem32_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XRem64S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xrem64_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XRem32U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xrem32_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XRem64U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xrem64_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XBand32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xband32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xband32S8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xband32_s8(sink, dst,src1,src2,)
        }
        
        RawInst::Xband32S32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xband32_s32(sink, dst,src1,src2,)
        }
        
        RawInst::XBand64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xband64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xband64S8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xband64_s8(sink, dst,src1,src2,)
        }
        
        RawInst::Xband64S32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xband64_s32(sink, dst,src1,src2,)
        }
        
        RawInst::XBor32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xbor32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xbor32S8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xbor32_s8(sink, dst,src1,src2,)
        }
        
        RawInst::Xbor32S32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xbor32_s32(sink, dst,src1,src2,)
        }
        
        RawInst::XBor64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xbor64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xbor64S8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xbor64_s8(sink, dst,src1,src2,)
        }
        
        RawInst::Xbor64S32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xbor64_s32(sink, dst,src1,src2,)
        }
        
        RawInst::XBxor32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xbxor32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xbxor32S8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xbxor32_s8(sink, dst,src1,src2,)
        }
        
        RawInst::Xbxor32S32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xbxor32_s32(sink, dst,src1,src2,)
        }
        
        RawInst::XBxor64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xbxor64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xbxor64S8 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xbxor64_s8(sink, dst,src1,src2,)
        }
        
        RawInst::Xbxor64S32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::xbxor64_s32(sink, dst,src1,src2,)
        }
        
        RawInst::XBnot32 { dst,src, } => {
            
            pulley_interpreter::encode::xbnot32(sink, dst,src,)
        }
        
        RawInst::XBnot64 { dst,src, } => {
            
            pulley_interpreter::encode::xbnot64(sink, dst,src,)
        }
        
        RawInst::Xmin32U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmin32_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xmin32S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmin32_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xmax32U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmax32_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xmax32S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmax32_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xmin64U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmin64_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xmin64S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmin64_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xmax64U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmax64_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xmax64S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmax64_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XSelect32 { dst,cond,if_nonzero,if_zero, } => {
            
            pulley_interpreter::encode::xselect32(sink, dst,cond,if_nonzero,if_zero,)
        }
        
        RawInst::XSelect64 { dst,cond,if_nonzero,if_zero, } => {
            
            pulley_interpreter::encode::xselect64(sink, dst,cond,if_nonzero,if_zero,)
        }
        
        RawInst::Trap { code, } => {
            sink.add_trap(code);

            pulley_interpreter::encode::trap(sink, )
        }
        
        RawInst::Xpcadd { dst,offset, } => {
            
            pulley_interpreter::encode::xpcadd(sink, dst,offset,)
        }
        
        RawInst::XmovFp { dst, } => {
            
            pulley_interpreter::encode::xmov_fp(sink, dst,)
        }
        
        RawInst::XmovLr { dst, } => {
            
            pulley_interpreter::encode::xmov_lr(sink, dst,)
        }
        
        RawInst::Bswap32 { dst,src, } => {
            
            pulley_interpreter::encode::bswap32(sink, dst,src,)
        }
        
        RawInst::Bswap64 { dst,src, } => {
            
            pulley_interpreter::encode::bswap64(sink, dst,src,)
        }
        
        RawInst::Xadd32UoverflowTrap { dst, src1, src2,code, } => {
            sink.add_trap(code);

            pulley_interpreter::encode::xadd32_uoverflow_trap(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xadd64UoverflowTrap { dst, src1, src2,code, } => {
            sink.add_trap(code);

            pulley_interpreter::encode::xadd64_uoverflow_trap(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XMulHi64S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmulhi64_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::XMulHi64U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::xmulhi64_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Xbmask32 { dst,src, } => {
            
            pulley_interpreter::encode::xbmask32(sink, dst,src,)
        }
        
        RawInst::Xbmask64 { dst,src, } => {
            
            pulley_interpreter::encode::xbmask64(sink, dst,src,)
        }
        
        RawInst::XLoad16BeU32O32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload16be_u32_o32(sink, dst,addr,)
        }
        
        RawInst::XLoad16BeS32O32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload16be_s32_o32(sink, dst,addr,)
        }
        
        RawInst::XLoad32BeO32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload32be_o32(sink, dst,addr,)
        }
        
        RawInst::XLoad64BeO32 { dst,addr, } => {
            
            pulley_interpreter::encode::xload64be_o32(sink, dst,addr,)
        }
        
        RawInst::XStore16BeO32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore16be_o32(sink, addr,src,)
        }
        
        RawInst::XStore32BeO32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore32be_o32(sink, addr,src,)
        }
        
        RawInst::XStore64BeO32 { addr,src, } => {
            
            pulley_interpreter::encode::xstore64be_o32(sink, addr,src,)
        }
        
        RawInst::Fload32BeO32 { dst,addr, } => {
            
            pulley_interpreter::encode::fload32be_o32(sink, dst,addr,)
        }
        
        RawInst::Fload64BeO32 { dst,addr, } => {
            
            pulley_interpreter::encode::fload64be_o32(sink, dst,addr,)
        }
        
        RawInst::Fstore32BeO32 { addr,src, } => {
            
            pulley_interpreter::encode::fstore32be_o32(sink, addr,src,)
        }
        
        RawInst::Fstore64BeO32 { addr,src, } => {
            
            pulley_interpreter::encode::fstore64be_o32(sink, addr,src,)
        }
        
        RawInst::Fload32LeO32 { dst,addr, } => {
            
            pulley_interpreter::encode::fload32le_o32(sink, dst,addr,)
        }
        
        RawInst::Fload64LeO32 { dst,addr, } => {
            
            pulley_interpreter::encode::fload64le_o32(sink, dst,addr,)
        }
        
        RawInst::Fstore32LeO32 { addr,src, } => {
            
            pulley_interpreter::encode::fstore32le_o32(sink, addr,src,)
        }
        
        RawInst::Fstore64LeO32 { addr,src, } => {
            
            pulley_interpreter::encode::fstore64le_o32(sink, addr,src,)
        }
        
        RawInst::Fload32LeZ { dst,addr, } => {
            
            pulley_interpreter::encode::fload32le_z(sink, dst,addr,)
        }
        
        RawInst::Fload64LeZ { dst,addr, } => {
            
            pulley_interpreter::encode::fload64le_z(sink, dst,addr,)
        }
        
        RawInst::Fstore32LeZ { addr,src, } => {
            
            pulley_interpreter::encode::fstore32le_z(sink, addr,src,)
        }
        
        RawInst::Fstore64LeZ { addr,src, } => {
            
            pulley_interpreter::encode::fstore64le_z(sink, addr,src,)
        }
        
        RawInst::Fload32LeG32 { dst,addr, } => {
            
            pulley_interpreter::encode::fload32le_g32(sink, dst,addr,)
        }
        
        RawInst::Fload64LeG32 { dst,addr, } => {
            
            pulley_interpreter::encode::fload64le_g32(sink, dst,addr,)
        }
        
        RawInst::Fstore32LeG32 { addr,src, } => {
            
            pulley_interpreter::encode::fstore32le_g32(sink, addr,src,)
        }
        
        RawInst::Fstore64LeG32 { addr,src, } => {
            
            pulley_interpreter::encode::fstore64le_g32(sink, addr,src,)
        }
        
        RawInst::VLoad128O32 { dst,addr, } => {
            
            pulley_interpreter::encode::vload128le_o32(sink, dst,addr,)
        }
        
        RawInst::Vstore128LeO32 { addr,src, } => {
            
            pulley_interpreter::encode::vstore128le_o32(sink, addr,src,)
        }
        
        RawInst::VLoad128Z { dst,addr, } => {
            
            pulley_interpreter::encode::vload128le_z(sink, dst,addr,)
        }
        
        RawInst::Vstore128LeZ { addr,src, } => {
            
            pulley_interpreter::encode::vstore128le_z(sink, addr,src,)
        }
        
        RawInst::VLoad128G32 { dst,addr, } => {
            
            pulley_interpreter::encode::vload128le_g32(sink, dst,addr,)
        }
        
        RawInst::Vstore128LeG32 { addr,src, } => {
            
            pulley_interpreter::encode::vstore128le_g32(sink, addr,src,)
        }
        
        RawInst::Fmov { dst,src, } => {
            
            pulley_interpreter::encode::fmov(sink, dst,src,)
        }
        
        RawInst::Vmov { dst,src, } => {
            
            pulley_interpreter::encode::vmov(sink, dst,src,)
        }
        
        RawInst::BitcastIntFromFloat32 { dst,src, } => {
            
            pulley_interpreter::encode::bitcast_int_from_float_32(sink, dst,src,)
        }
        
        RawInst::BitcastIntFromFloat64 { dst,src, } => {
            
            pulley_interpreter::encode::bitcast_int_from_float_64(sink, dst,src,)
        }
        
        RawInst::BitcastFloatFromInt32 { dst,src, } => {
            
            pulley_interpreter::encode::bitcast_float_from_int_32(sink, dst,src,)
        }
        
        RawInst::BitcastFloatFromInt64 { dst,src, } => {
            
            pulley_interpreter::encode::bitcast_float_from_int_64(sink, dst,src,)
        }
        
        RawInst::FConst32 { dst,bits, } => {
            
            pulley_interpreter::encode::fconst32(sink, dst,bits,)
        }
        
        RawInst::FConst64 { dst,bits, } => {
            
            pulley_interpreter::encode::fconst64(sink, dst,bits,)
        }
        
        RawInst::Feq32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::feq32(sink, dst,src1,src2,)
        }
        
        RawInst::Fneq32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::fneq32(sink, dst,src1,src2,)
        }
        
        RawInst::Flt32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::flt32(sink, dst,src1,src2,)
        }
        
        RawInst::Flteq32 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::flteq32(sink, dst,src1,src2,)
        }
        
        RawInst::Feq64 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::feq64(sink, dst,src1,src2,)
        }
        
        RawInst::Fneq64 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::fneq64(sink, dst,src1,src2,)
        }
        
        RawInst::Flt64 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::flt64(sink, dst,src1,src2,)
        }
        
        RawInst::Flteq64 { dst,src1,src2, } => {
            
            pulley_interpreter::encode::flteq64(sink, dst,src1,src2,)
        }
        
        RawInst::FSelect32 { dst,cond,if_nonzero,if_zero, } => {
            
            pulley_interpreter::encode::fselect32(sink, dst,cond,if_nonzero,if_zero,)
        }
        
        RawInst::FSelect64 { dst,cond,if_nonzero,if_zero, } => {
            
            pulley_interpreter::encode::fselect64(sink, dst,cond,if_nonzero,if_zero,)
        }
        
        RawInst::F32FromF64 { dst,src, } => {
            
            pulley_interpreter::encode::f32_from_f64(sink, dst,src,)
        }
        
        RawInst::F64FromF32 { dst,src, } => {
            
            pulley_interpreter::encode::f64_from_f32(sink, dst,src,)
        }
        
        RawInst::F32FromX32S { dst,src, } => {
            
            pulley_interpreter::encode::f32_from_x32_s(sink, dst,src,)
        }
        
        RawInst::F32FromX32U { dst,src, } => {
            
            pulley_interpreter::encode::f32_from_x32_u(sink, dst,src,)
        }
        
        RawInst::F32FromX64S { dst,src, } => {
            
            pulley_interpreter::encode::f32_from_x64_s(sink, dst,src,)
        }
        
        RawInst::F32FromX64U { dst,src, } => {
            
            pulley_interpreter::encode::f32_from_x64_u(sink, dst,src,)
        }
        
        RawInst::F64FromX32S { dst,src, } => {
            
            pulley_interpreter::encode::f64_from_x32_s(sink, dst,src,)
        }
        
        RawInst::F64FromX32U { dst,src, } => {
            
            pulley_interpreter::encode::f64_from_x32_u(sink, dst,src,)
        }
        
        RawInst::F64FromX64S { dst,src, } => {
            
            pulley_interpreter::encode::f64_from_x64_s(sink, dst,src,)
        }
        
        RawInst::F64FromX64U { dst,src, } => {
            
            pulley_interpreter::encode::f64_from_x64_u(sink, dst,src,)
        }
        
        RawInst::X32FromF32S { dst,src, } => {
            
            pulley_interpreter::encode::x32_from_f32_s(sink, dst,src,)
        }
        
        RawInst::X32FromF32U { dst,src, } => {
            
            pulley_interpreter::encode::x32_from_f32_u(sink, dst,src,)
        }
        
        RawInst::X32FromF64S { dst,src, } => {
            
            pulley_interpreter::encode::x32_from_f64_s(sink, dst,src,)
        }
        
        RawInst::X32FromF64U { dst,src, } => {
            
            pulley_interpreter::encode::x32_from_f64_u(sink, dst,src,)
        }
        
        RawInst::X64FromF32S { dst,src, } => {
            
            pulley_interpreter::encode::x64_from_f32_s(sink, dst,src,)
        }
        
        RawInst::X64FromF32U { dst,src, } => {
            
            pulley_interpreter::encode::x64_from_f32_u(sink, dst,src,)
        }
        
        RawInst::X64FromF64S { dst,src, } => {
            
            pulley_interpreter::encode::x64_from_f64_s(sink, dst,src,)
        }
        
        RawInst::X64FromF64U { dst,src, } => {
            
            pulley_interpreter::encode::x64_from_f64_u(sink, dst,src,)
        }
        
        RawInst::X32FromF32SSat { dst,src, } => {
            
            pulley_interpreter::encode::x32_from_f32_s_sat(sink, dst,src,)
        }
        
        RawInst::X32FromF32USat { dst,src, } => {
            
            pulley_interpreter::encode::x32_from_f32_u_sat(sink, dst,src,)
        }
        
        RawInst::X32FromF64SSat { dst,src, } => {
            
            pulley_interpreter::encode::x32_from_f64_s_sat(sink, dst,src,)
        }
        
        RawInst::X32FromF64USat { dst,src, } => {
            
            pulley_interpreter::encode::x32_from_f64_u_sat(sink, dst,src,)
        }
        
        RawInst::X64FromF32SSat { dst,src, } => {
            
            pulley_interpreter::encode::x64_from_f32_s_sat(sink, dst,src,)
        }
        
        RawInst::X64FromF32USat { dst,src, } => {
            
            pulley_interpreter::encode::x64_from_f32_u_sat(sink, dst,src,)
        }
        
        RawInst::X64FromF64SSat { dst,src, } => {
            
            pulley_interpreter::encode::x64_from_f64_s_sat(sink, dst,src,)
        }
        
        RawInst::X64FromF64USat { dst,src, } => {
            
            pulley_interpreter::encode::x64_from_f64_u_sat(sink, dst,src,)
        }
        
        RawInst::FCopySign32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fcopysign32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::FCopySign64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fcopysign64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fadd32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fadd32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fsub32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fsub32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vsubf32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vsubf32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fmul32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fmul32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmulf32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmulf32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fdiv32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fdiv32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vdivf32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vdivf32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fmaximum32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fmaximum32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fminimum32 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fminimum32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Ftrunc32 { dst,src, } => {
            
            pulley_interpreter::encode::ftrunc32(sink, dst,src,)
        }
        
        RawInst::Vtrunc32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vtrunc32x4(sink, dst,src,)
        }
        
        RawInst::Vtrunc64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vtrunc64x2(sink, dst,src,)
        }
        
        RawInst::Ffloor32 { dst,src, } => {
            
            pulley_interpreter::encode::ffloor32(sink, dst,src,)
        }
        
        RawInst::Vfloor32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vfloor32x4(sink, dst,src,)
        }
        
        RawInst::Vfloor64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vfloor64x2(sink, dst,src,)
        }
        
        RawInst::Fceil32 { dst,src, } => {
            
            pulley_interpreter::encode::fceil32(sink, dst,src,)
        }
        
        RawInst::Vceil32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vceil32x4(sink, dst,src,)
        }
        
        RawInst::Vceil64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vceil64x2(sink, dst,src,)
        }
        
        RawInst::Fnearest32 { dst,src, } => {
            
            pulley_interpreter::encode::fnearest32(sink, dst,src,)
        }
        
        RawInst::Fsqrt32 { dst,src, } => {
            
            pulley_interpreter::encode::fsqrt32(sink, dst,src,)
        }
        
        RawInst::Vsqrt32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vsqrt32x4(sink, dst,src,)
        }
        
        RawInst::Vsqrt64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vsqrt64x2(sink, dst,src,)
        }
        
        RawInst::Fneg32 { dst,src, } => {
            
            pulley_interpreter::encode::fneg32(sink, dst,src,)
        }
        
        RawInst::Vnegf32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vnegf32x4(sink, dst,src,)
        }
        
        RawInst::Fabs32 { dst,src, } => {
            
            pulley_interpreter::encode::fabs32(sink, dst,src,)
        }
        
        RawInst::Fadd64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fadd64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fsub64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fsub64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fmul64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fmul64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fdiv64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fdiv64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VDivF64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vdivf64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fmaximum64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fmaximum64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Fminimum64 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::fminimum64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Ftrunc64 { dst,src, } => {
            
            pulley_interpreter::encode::ftrunc64(sink, dst,src,)
        }
        
        RawInst::Ffloor64 { dst,src, } => {
            
            pulley_interpreter::encode::ffloor64(sink, dst,src,)
        }
        
        RawInst::Fceil64 { dst,src, } => {
            
            pulley_interpreter::encode::fceil64(sink, dst,src,)
        }
        
        RawInst::Fnearest64 { dst,src, } => {
            
            pulley_interpreter::encode::fnearest64(sink, dst,src,)
        }
        
        RawInst::Vnearest32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vnearest32x4(sink, dst,src,)
        }
        
        RawInst::Vnearest64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vnearest64x2(sink, dst,src,)
        }
        
        RawInst::Fsqrt64 { dst,src, } => {
            
            pulley_interpreter::encode::fsqrt64(sink, dst,src,)
        }
        
        RawInst::Fneg64 { dst,src, } => {
            
            pulley_interpreter::encode::fneg64(sink, dst,src,)
        }
        
        RawInst::Fabs64 { dst,src, } => {
            
            pulley_interpreter::encode::fabs64(sink, dst,src,)
        }
        
        RawInst::Vconst128 { dst,imm, } => {
            
            pulley_interpreter::encode::vconst128(sink, dst,imm,)
        }
        
        RawInst::VAddI8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddi8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddI16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddi16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddI32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddi32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddI64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddi64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddF32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddf32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddF64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddf64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddI8x16Sat { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddi8x16_sat(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddU8x16Sat { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddu8x16_sat(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddI16x8Sat { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddi16x8_sat(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddU16x8Sat { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddu16x8_sat(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddpairwiseI16x8S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddpairwisei16x8_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VAddpairwiseI32x4S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vaddpairwisei32x4_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShlI8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshli8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShlI16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshli16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShlI32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshli32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShlI64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshli64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShrI8x16S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshri8x16_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShrI16x8S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshri16x8_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShrI32x4S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshri32x4_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShrI64x2S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshri64x2_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShrI8x16U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshri8x16_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShrI16x8U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshri16x8_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShrI32x4U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshri32x4_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShrI64x2U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vshri64x2_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VSplatX8 { dst,src, } => {
            
            pulley_interpreter::encode::vsplatx8(sink, dst,src,)
        }
        
        RawInst::VSplatX16 { dst,src, } => {
            
            pulley_interpreter::encode::vsplatx16(sink, dst,src,)
        }
        
        RawInst::VSplatX32 { dst,src, } => {
            
            pulley_interpreter::encode::vsplatx32(sink, dst,src,)
        }
        
        RawInst::VSplatX64 { dst,src, } => {
            
            pulley_interpreter::encode::vsplatx64(sink, dst,src,)
        }
        
        RawInst::VSplatF32 { dst,src, } => {
            
            pulley_interpreter::encode::vsplatf32(sink, dst,src,)
        }
        
        RawInst::VSplatF64 { dst,src, } => {
            
            pulley_interpreter::encode::vsplatf64(sink, dst,src,)
        }
        
        RawInst::VLoad8x8SZ { dst,addr, } => {
            
            pulley_interpreter::encode::vload8x8_s_z(sink, dst,addr,)
        }
        
        RawInst::VLoad8x8UZ { dst,addr, } => {
            
            pulley_interpreter::encode::vload8x8_u_z(sink, dst,addr,)
        }
        
        RawInst::VLoad16x4LeSZ { dst,addr, } => {
            
            pulley_interpreter::encode::vload16x4le_s_z(sink, dst,addr,)
        }
        
        RawInst::VLoad16x4LeUZ { dst,addr, } => {
            
            pulley_interpreter::encode::vload16x4le_u_z(sink, dst,addr,)
        }
        
        RawInst::VLoad32x2LeSZ { dst,addr, } => {
            
            pulley_interpreter::encode::vload32x2le_s_z(sink, dst,addr,)
        }
        
        RawInst::VLoad32x2LeUZ { dst,addr, } => {
            
            pulley_interpreter::encode::vload32x2le_u_z(sink, dst,addr,)
        }
        
        RawInst::VBand128 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vband128(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VBor128 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vbor128(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VBxor128 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vbxor128(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VBnot128 { dst,src, } => {
            
            pulley_interpreter::encode::vbnot128(sink, dst,src,)
        }
        
        RawInst::VBitselect128 { dst,c,x,y, } => {
            
            pulley_interpreter::encode::vbitselect128(sink, dst,c,x,y,)
        }
        
        RawInst::Vbitmask8x16 { dst,src, } => {
            
            pulley_interpreter::encode::vbitmask8x16(sink, dst,src,)
        }
        
        RawInst::Vbitmask16x8 { dst,src, } => {
            
            pulley_interpreter::encode::vbitmask16x8(sink, dst,src,)
        }
        
        RawInst::Vbitmask32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vbitmask32x4(sink, dst,src,)
        }
        
        RawInst::Vbitmask64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vbitmask64x2(sink, dst,src,)
        }
        
        RawInst::Valltrue8x16 { dst,src, } => {
            
            pulley_interpreter::encode::valltrue8x16(sink, dst,src,)
        }
        
        RawInst::Valltrue16x8 { dst,src, } => {
            
            pulley_interpreter::encode::valltrue16x8(sink, dst,src,)
        }
        
        RawInst::Valltrue32x4 { dst,src, } => {
            
            pulley_interpreter::encode::valltrue32x4(sink, dst,src,)
        }
        
        RawInst::Valltrue64x2 { dst,src, } => {
            
            pulley_interpreter::encode::valltrue64x2(sink, dst,src,)
        }
        
        RawInst::Vanytrue8x16 { dst,src, } => {
            
            pulley_interpreter::encode::vanytrue8x16(sink, dst,src,)
        }
        
        RawInst::Vanytrue16x8 { dst,src, } => {
            
            pulley_interpreter::encode::vanytrue16x8(sink, dst,src,)
        }
        
        RawInst::Vanytrue32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vanytrue32x4(sink, dst,src,)
        }
        
        RawInst::Vanytrue64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vanytrue64x2(sink, dst,src,)
        }
        
        RawInst::VF32x4FromI32x4S { dst,src, } => {
            
            pulley_interpreter::encode::vf32x4_from_i32x4_s(sink, dst,src,)
        }
        
        RawInst::VF32x4FromI32x4U { dst,src, } => {
            
            pulley_interpreter::encode::vf32x4_from_i32x4_u(sink, dst,src,)
        }
        
        RawInst::VF64x2FromI64x2S { dst,src, } => {
            
            pulley_interpreter::encode::vf64x2_from_i64x2_s(sink, dst,src,)
        }
        
        RawInst::VF64x2FromI64x2U { dst,src, } => {
            
            pulley_interpreter::encode::vf64x2_from_i64x2_u(sink, dst,src,)
        }
        
        RawInst::VI32x4FromF32x4S { dst,src, } => {
            
            pulley_interpreter::encode::vi32x4_from_f32x4_s(sink, dst,src,)
        }
        
        RawInst::VI32x4FromF32x4U { dst,src, } => {
            
            pulley_interpreter::encode::vi32x4_from_f32x4_u(sink, dst,src,)
        }
        
        RawInst::VI64x2FromF64x2S { dst,src, } => {
            
            pulley_interpreter::encode::vi64x2_from_f64x2_s(sink, dst,src,)
        }
        
        RawInst::VI64x2FromF64x2U { dst,src, } => {
            
            pulley_interpreter::encode::vi64x2_from_f64x2_u(sink, dst,src,)
        }
        
        RawInst::VWidenLow8x16S { dst,src, } => {
            
            pulley_interpreter::encode::vwidenlow8x16_s(sink, dst,src,)
        }
        
        RawInst::VWidenLow8x16U { dst,src, } => {
            
            pulley_interpreter::encode::vwidenlow8x16_u(sink, dst,src,)
        }
        
        RawInst::VWidenLow16x8S { dst,src, } => {
            
            pulley_interpreter::encode::vwidenlow16x8_s(sink, dst,src,)
        }
        
        RawInst::VWidenLow16x8U { dst,src, } => {
            
            pulley_interpreter::encode::vwidenlow16x8_u(sink, dst,src,)
        }
        
        RawInst::VWidenLow32x4S { dst,src, } => {
            
            pulley_interpreter::encode::vwidenlow32x4_s(sink, dst,src,)
        }
        
        RawInst::VWidenLow32x4U { dst,src, } => {
            
            pulley_interpreter::encode::vwidenlow32x4_u(sink, dst,src,)
        }
        
        RawInst::VWidenHigh8x16S { dst,src, } => {
            
            pulley_interpreter::encode::vwidenhigh8x16_s(sink, dst,src,)
        }
        
        RawInst::VWidenHigh8x16U { dst,src, } => {
            
            pulley_interpreter::encode::vwidenhigh8x16_u(sink, dst,src,)
        }
        
        RawInst::VWidenHigh16x8S { dst,src, } => {
            
            pulley_interpreter::encode::vwidenhigh16x8_s(sink, dst,src,)
        }
        
        RawInst::VWidenHigh16x8U { dst,src, } => {
            
            pulley_interpreter::encode::vwidenhigh16x8_u(sink, dst,src,)
        }
        
        RawInst::VWidenHigh32x4S { dst,src, } => {
            
            pulley_interpreter::encode::vwidenhigh32x4_s(sink, dst,src,)
        }
        
        RawInst::VWidenHigh32x4U { dst,src, } => {
            
            pulley_interpreter::encode::vwidenhigh32x4_u(sink, dst,src,)
        }
        
        RawInst::Vnarrow16x8S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vnarrow16x8_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vnarrow16x8U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vnarrow16x8_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vnarrow32x4S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vnarrow32x4_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vnarrow32x4U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vnarrow32x4_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vnarrow64x2S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vnarrow64x2_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vnarrow64x2U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vnarrow64x2_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vunarrow64x2U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vunarrow64x2_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VFpromoteLow { dst,src, } => {
            
            pulley_interpreter::encode::vfpromotelow(sink, dst,src,)
        }
        
        RawInst::VFdemote { dst,src, } => {
            
            pulley_interpreter::encode::vfdemote(sink, dst,src,)
        }
        
        RawInst::VSubI8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vsubi8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VSubI16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vsubi16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VSubI32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vsubi32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VSubI64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vsubi64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VSubF64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vsubf64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VSubI8x16Sat { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vsubi8x16_sat(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VSubU8x16Sat { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vsubu8x16_sat(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VSubI16x8Sat { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vsubi16x8_sat(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VSubU16x8Sat { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vsubu16x8_sat(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VMulI8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmuli8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VMulI16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmuli16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VMulI32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmuli32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VMulI64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmuli64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VMulF64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmulf64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VQmulrsI16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vqmulrsi16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VPopcnt8x16 { dst,src, } => {
            
            pulley_interpreter::encode::vpopcnt8x16(sink, dst,src,)
        }
        
        RawInst::XExtractV8x16 { dst,src,lane, } => {
            
            pulley_interpreter::encode::xextractv8x16(sink, dst,src,lane,)
        }
        
        RawInst::XExtractV16x8 { dst,src,lane, } => {
            
            pulley_interpreter::encode::xextractv16x8(sink, dst,src,lane,)
        }
        
        RawInst::XExtractV32x4 { dst,src,lane, } => {
            
            pulley_interpreter::encode::xextractv32x4(sink, dst,src,lane,)
        }
        
        RawInst::XExtractV64x2 { dst,src,lane, } => {
            
            pulley_interpreter::encode::xextractv64x2(sink, dst,src,lane,)
        }
        
        RawInst::FExtractV32x4 { dst,src,lane, } => {
            
            pulley_interpreter::encode::fextractv32x4(sink, dst,src,lane,)
        }
        
        RawInst::FExtractV64x2 { dst,src,lane, } => {
            
            pulley_interpreter::encode::fextractv64x2(sink, dst,src,lane,)
        }
        
        RawInst::VInsertX8 { dst, src1, src2,lane, } => {
            
            pulley_interpreter::encode::vinsertx8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),lane,)
        }
        
        RawInst::VInsertX16 { dst, src1, src2,lane, } => {
            
            pulley_interpreter::encode::vinsertx16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),lane,)
        }
        
        RawInst::VInsertX32 { dst, src1, src2,lane, } => {
            
            pulley_interpreter::encode::vinsertx32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),lane,)
        }
        
        RawInst::VInsertX64 { dst, src1, src2,lane, } => {
            
            pulley_interpreter::encode::vinsertx64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),lane,)
        }
        
        RawInst::VInsertF32 { dst, src1, src2,lane, } => {
            
            pulley_interpreter::encode::vinsertf32(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),lane,)
        }
        
        RawInst::VInsertF64 { dst, src1, src2,lane, } => {
            
            pulley_interpreter::encode::vinsertf64(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),lane,)
        }
        
        RawInst::Veq8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::veq8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vneq8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vneq8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vslt8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vslt8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vslteq8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vslteq8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vult8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vult8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vulteq8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vulteq8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Veq16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::veq16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vneq16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vneq16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vslt16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vslt16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vslteq16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vslteq16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vult16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vult16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vulteq16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vulteq16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Veq32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::veq32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vneq32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vneq32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vslt32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vslt32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vslteq32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vslteq32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vult32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vult32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vulteq32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vulteq32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Veq64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::veq64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vneq64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vneq64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vslt64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vslt64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vslteq64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vslteq64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vult64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vult64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vulteq64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vulteq64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vneg8x16 { dst,src, } => {
            
            pulley_interpreter::encode::vneg8x16(sink, dst,src,)
        }
        
        RawInst::Vneg16x8 { dst,src, } => {
            
            pulley_interpreter::encode::vneg16x8(sink, dst,src,)
        }
        
        RawInst::Vneg32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vneg32x4(sink, dst,src,)
        }
        
        RawInst::Vneg64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vneg64x2(sink, dst,src,)
        }
        
        RawInst::VnegF64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vnegf64x2(sink, dst,src,)
        }
        
        RawInst::Vmin8x16S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmin8x16_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmin8x16U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmin8x16_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmin16x8S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmin16x8_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmin16x8U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmin16x8_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmax8x16S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmax8x16_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmax8x16U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmax8x16_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmax16x8S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmax16x8_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmax16x8U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmax16x8_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmin32x4S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmin32x4_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmin32x4U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmin32x4_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmax32x4S { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmax32x4_s(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmax32x4U { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmax32x4_u(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vabs8x16 { dst,src, } => {
            
            pulley_interpreter::encode::vabs8x16(sink, dst,src,)
        }
        
        RawInst::Vabs16x8 { dst,src, } => {
            
            pulley_interpreter::encode::vabs16x8(sink, dst,src,)
        }
        
        RawInst::Vabs32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vabs32x4(sink, dst,src,)
        }
        
        RawInst::Vabs64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vabs64x2(sink, dst,src,)
        }
        
        RawInst::Vabsf32x4 { dst,src, } => {
            
            pulley_interpreter::encode::vabsf32x4(sink, dst,src,)
        }
        
        RawInst::Vabsf64x2 { dst,src, } => {
            
            pulley_interpreter::encode::vabsf64x2(sink, dst,src,)
        }
        
        RawInst::Vmaximumf32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmaximumf32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vmaximumf64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vmaximumf64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vminimumf32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vminimumf32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vminimumf64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vminimumf64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VShuffle { dst,src1,src2,mask, } => {
            
            pulley_interpreter::encode::vshuffle(sink, dst,src1,src2,mask,)
        }
        
        RawInst::Vswizzlei8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vswizzlei8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vavground8x16 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vavground8x16(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vavground16x8 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vavground16x8(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VeqF32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::veqf32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VneqF32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vneqf32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VltF32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vltf32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VlteqF32x4 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vlteqf32x4(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VeqF64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::veqf64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VneqF64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vneqf64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VltF64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vltf64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::VlteqF64x2 { dst, src1, src2, } => {
            
            pulley_interpreter::encode::vlteqf64x2(sink, pulley_interpreter::regs::BinaryOperands::new(dst, src1, src2),)
        }
        
        RawInst::Vfma32x4 { dst,a,b,c, } => {
            
            pulley_interpreter::encode::vfma32x4(sink, dst,a,b,c,)
        }
        
        RawInst::Vfma64x2 { dst,a,b,c, } => {
            
            pulley_interpreter::encode::vfma64x2(sink, dst,a,b,c,)
        }
        
        RawInst::Vselect { dst,cond,if_nonzero,if_zero, } => {
            
            pulley_interpreter::encode::vselect(sink, dst,cond,if_nonzero,if_zero,)
        }
        
        RawInst::Xadd128 { dst_lo,dst_hi,lhs_lo,lhs_hi,rhs_lo,rhs_hi, } => {
            
            pulley_interpreter::encode::xadd128(sink, dst_lo,dst_hi,lhs_lo,lhs_hi,rhs_lo,rhs_hi,)
        }
        
        RawInst::Xsub128 { dst_lo,dst_hi,lhs_lo,lhs_hi,rhs_lo,rhs_hi, } => {
            
            pulley_interpreter::encode::xsub128(sink, dst_lo,dst_hi,lhs_lo,lhs_hi,rhs_lo,rhs_hi,)
        }
        
        RawInst::Xwidemul64S { dst_lo,dst_hi,lhs,rhs, } => {
            
            pulley_interpreter::encode::xwidemul64_s(sink, dst_lo,dst_hi,lhs,rhs,)
        }
        
        RawInst::Xwidemul64U { dst_lo,dst_hi,lhs,rhs, } => {
            
            pulley_interpreter::encode::xwidemul64_u(sink, dst_lo,dst_hi,lhs,rhs,)
        }
        }
}
