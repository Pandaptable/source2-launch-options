
use crate::murmur::token_hash;
use crate::slots::{TokenMethod, token_method};
use serde::Serialize;
use iced_x86::{Decoder, DecoderOptions, Instruction, Mnemonic, OpKind, Register};
use std::collections::{HashMap, HashSet};

/// A discovered launch-option token site.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Site {
	pub hash: u64,
	pub slot: u64,
	pub method: Option<TokenMethod>,
	/// VA of the indirect call that consumed the token.
	pub va: u64,
	/// Option name recovered from a runtime-hashed string literal.
	pub name: Option<String>,
	/// Whether this call reads a value after the token. `None` when the
	/// method is value-capable but the value argument could not be resolved.
	pub value: Option<bool>,
	/// One copy of an inlined helper: the same instruction shape appears
	/// in three or more functions of this module.
	pub inlined: bool,
}

/// How a site's result combines with a later site's in the same function.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Relation {
	/// The later site is only reached when the earlier one succeeded (&&).
	Requires,
	/// The later site is only reached when the earlier one failed (||).
	Alternative,
	/// `a && !b`: both jumps leave to the same target with opposite
	/// flavors, so the later option negates the earlier one (the -no
	/// family, like -nop4 under -p4).
	Negates,
}

/// A directed relation between two token sites: `later` relates to `earlier`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct SiteRelation {
	/// Hash of the option whose check comes first.
	pub earlier: u64,
	/// Hash of the option whose check comes second and is conditional.
	pub later: u64,
	pub relation: Relation,
	/// VA of the conditional jump that established the relation.
	pub branch_va: u64,
}

/// Section mapping used to translate VAs to file offsets.
#[derive(Clone, Copy, Debug)]
pub struct SectionMap {
	pub va: u64,
	pub vsize: u64,
	pub raw_offset: usize,
	pub raw_size: usize,
}

/// Read-only view over a parsed PE image.
pub struct ModuleView<'a> {
	pub buffer: &'a [u8],
	pub image_base: u64,
	pub sections: Vec<SectionMap>,
}

impl ModuleView<'_> {
	pub fn va_to_offset(&self, va: u64) -> Option<usize> {
		let s = self.sections.iter().find(|s| {
			let start = self.image_base + s.va;
			va >= start && va < start + s.vsize.max(s.raw_size as u64)
		})?;
		let off = (va - self.image_base - s.va) as usize + s.raw_offset;
		(off + 8 <= self.buffer.len()).then_some(off)
	}

	/// Reads a NUL-terminated ASCII/UTF-8 string at `va`.
	pub fn read_cstr(&self, va: u64) -> Option<String> {
		let start = self.va_to_offset(va)?;
		let bytes = &self.buffer[start..];
		let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
		(end > 0 && end <= 256).then(|| String::from_utf8_lossy(&bytes[..end]).into_owned())
	}
}

/// Origin/target configuration for one module.
#[derive(Clone, Default)]
pub struct ScanConfig {
	/// IAT slot VAs holding the imported `CommandLine` pointer.
	pub iat_vas: Vec<u64>,
	/// VAs of the exported `CommandLine` function itself (tier0).
	pub export_vas: Vec<u64>,
	/// VAs of the statically allocated CCommandLine object.
	pub global_vas: Vec<u64>,
	/// VAs of module-local globals caching a CCommandLine pointer: the
	/// object was acquired through a known origin at init and stored.
	/// `mov reg, [rip+X]` on these yields the object pointer.
	pub cached_vas: Vec<u64>,
	/// VAs of murmur-hash helper functions (string -> token in EAX).
	pub murmur_vas: Vec<u64>,
	/// Wrapper function entry -> token slot it consumes (pass 2).
	pub wrappers: Vec<(u64, u64)>,
	/// Forward instruction budget per origin.
	pub window: usize,
}

impl ScanConfig {
	pub fn with_window(window: usize) -> Self {
		Self {
			window,
			..ScanConfig::default()
		}
	}
}

/// A token-method call whose token register was never written in the
/// tracking window: the value is an incoming parameter of the enclosing
/// function, which makes that function a token-consuming wrapper.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ParamSite {
	/// VA of the indirect call that consumed the parameter token.
	pub va: u64,
	pub slot: u64,
}

/// Picks the exports that produce a CCommandLine object from (name, rva)
/// pairs: `CommandLine` (the leaf accessor) and `CreateCommandLine`
/// (constructs and returns a new one; vconsole2 parses commands with
/// it). `FreeCommandLine` / `V_SanitizeTextForCommandLine` are ignored.
pub fn command_line_exports<'a, I: IntoIterator<Item = (&'a str, u64)>>(
	exports: I,
) -> Vec<u64> {
	exports
		.into_iter()
		.filter(|(name, _)| *name == "CommandLine" || *name == "CreateCommandLine")
		.map(|(_, rva)| rva)
		.collect()
}

/// Scans one executable section for token sites.
pub fn scan_text(
	view: &ModuleView,
	text: &[u8],
	text_va: u64,
	bitness: u32,
	cfg: &ScanConfig,
) -> Vec<Site> {
	let (sites, _params) = scan_text_with_params(view, text, text_va, bitness, cfg);
	sites
}

/// Full scan returning both confirmed sites and parameter sites.
pub fn scan_text_with_params(
	view: &ModuleView,
	text: &[u8],
	text_va: u64,
	bitness: u32,
	cfg: &ScanConfig,
) -> (Vec<Site>, Vec<ParamSite>) {
	let mut decoder = Decoder::with_ip(bitness, text, text_va, DecoderOptions::NONE);
	let mut insns = Vec::with_capacity(text.len() / 4);
	while decoder.can_decode() {
		let mut ins = Instruction::default();
		decoder.decode_out(&mut ins);
		insns.push(ins);
	}

	let window = cfg.window.max(1);
	let mut sites: Vec<Site> = Vec::new();
	let mut param_sites: Vec<ParamSite> = Vec::new();
	let wrapper_map: HashMap<u64, u64> = cfg.wrappers.iter().copied().collect();
	let mut murmur_names: HashMap<u64, String> = HashMap::new();

	for (idx, ins) in insns.iter().enumerate() {
		if ins.mnemonic() == Mnemonic::Call
			&& is_direct_branch(ins)
			&& let Some(&slot) = wrapper_map.get(&ins.near_branch_target())
		{
			for b in insns[idx.saturating_sub(8)..idx].iter().rev() {
				let writes_rdx = b.mnemonic() == Mnemonic::Mov
					&& b.op0_kind() == OpKind::Register
					&& base(b.op0_register()) == Register::RDX;
				if writes_rdx {
					if is_imm_op(b.op1_kind()) && is_plausible_token(b.immediate64()) {
						sites.push(Site {
							hash: b.immediate64(),
							slot,
							method: token_method(slot),
							va: ins.ip(),
							name: None,
							value: value_of_method(token_method(slot), None),
							inlined: false,
						});
					}
					break;
				}
			}
		}
		let mut state: Option<HashMap<Register, Val>> = None;

		if ins.is_ip_rel_memory_operand() {
			let target = ins.ip_rel_memory_address();
			if cfg.iat_vas.contains(&target) {
				let mut st = HashMap::new();
				if ins.mnemonic() == Mnemonic::Call {
					st.insert(Register::RAX, Val::Obj);
				} else if ins.op0_kind() == OpKind::Register {
					st.insert(base(ins.op0_register()), Val::LeafFn);
				}
				state = Some(st);
			} else if cfg.global_vas.contains(&target) {
				let mut st = HashMap::new();
				if ins.mnemonic() == Mnemonic::Lea && ins.op0_kind() == OpKind::Register {
					st.insert(base(ins.op0_register()), Val::Obj);
				} else if ins.mnemonic() == Mnemonic::Mov && ins.op0_kind() == OpKind::Register {
					st.insert(base(ins.op0_register()), Val::Vtable);
				}
				state = Some(st);
		} else if cfg.cached_vas.contains(&target) {
			if ins.mnemonic() == Mnemonic::Mov && ins.op0_kind() == OpKind::Register {
				let mut st = HashMap::new();
				st.insert(base(ins.op0_register()), Val::Obj);
				state = Some(st);
			}
		}
		} else if is_direct_branch(ins) {
			let target = ins.near_branch_target();
			if cfg.export_vas.contains(&target) && ins.mnemonic() == Mnemonic::Call {
				let mut st = HashMap::new();
				st.insert(Register::RAX, Val::Obj);
				state = Some(st);
			}
	} else if ins.mnemonic() == Mnemonic::Call
		&& ins.op0_kind() == OpKind::Memory
		&& base(ins.memory_base()) != Register::None
		&& !ins.is_ip_rel_memory_operand()
		&& ins.memory_displacement64() as i64 == 0x88
		&& callret_is_object(&insns, idx)
	{
		let mut st = HashMap::new();
		st.insert(Register::RAX, Val::Obj);
		state = Some(st);
	}

		let Some(mut st) = state else { continue };

		preseed(&insns[..idx], &mut st);

		let mut saw_call = false;
		'window: for step in 1..=window {
			let Some(ins) = insns.get(idx + step) else {
				break;
			};
			match ins.mnemonic() {
				Mnemonic::Ret | Mnemonic::Int3 | Mnemonic::Ud2 => break,
				Mnemonic::Mov => apply_mov(ins, &mut st),
				Mnemonic::Lea => apply_lea(ins, &mut st, &cfg.global_vas),
				Mnemonic::Xor => {
					if ins.op0_kind() == OpKind::Register
						&& ins.op1_kind() == OpKind::Register
						&& ins.op0_register() == ins.op1_register()
					{
						st.insert(base(ins.op0_register()), Val::Imm(0));
					}
				}
				Mnemonic::Call | Mnemonic::Jmp => {
					let slot = dispatch(ins, &st);
					match slot {
						Dispatch::TokenSite(slot) => {
							let token_imm = match st.get(&Register::RDX) {
								Some(Val::Imm(hash)) if is_plausible_token(*hash) => Some(*hash),
								_ => None,
							};
							match token_imm {
							Some(hash) => sites.push(Site {
								hash,
								slot,
								method: token_method(slot),
								va: ins.ip(),
								name: murmur_names.get(&hash).cloned(),
								value: value_of_method(token_method(slot), st.get(&Register::R8)),
								inlined: false,
							}),
								None if !saw_call => {
									param_sites.push(ParamSite { va: ins.ip(), slot })
								}
								None => {}
							}
							if ins.mnemonic() == Mnemonic::Jmp && !is_direct_branch(ins) {
								break 'window;
							}
						}
						Dispatch::MurmurOrExport => {
						}
						Dispatch::Other => {}
					}
					saw_call = true;
					apply_call_effects(ins, &mut st, view, cfg, &mut murmur_names);
					if ins.mnemonic() == Mnemonic::Jmp && !is_direct_branch(ins) {
						break 'window;
					}
				}
				_ => {
					if ins.op0_kind() == OpKind::Register && writes_op0(ins) {
						st.remove(&base(ins.op0_register()));
					}
				}
			}
		}
	}

	sites.sort_unstable_by_key(|s| (s.hash, s.slot, s.va));
	sites.dedup_by_key(|s| (s.hash, s.slot, s.va));
	param_sites.sort_unstable();
	param_sites.dedup();
	(sites, param_sites)
}

fn is_imm_op(kind: OpKind) -> bool {
	matches!(
		kind,
		OpKind::Immediate8
			| OpKind::Immediate8to16
			| OpKind::Immediate8to32
			| OpKind::Immediate8to64
			| OpKind::Immediate16
			| OpKind::Immediate32
			| OpKind::Immediate64
	)
}

/// Two-pass scan with cached-getter propagation.
///
/// Pass 1 finds direct sites plus parameter sites (functions whose token
/// comes from their own EDX parameter). Each parameter site turns its
/// enclosing function into a wrapper; pass 2 re-scans with those wrapper
/// entries as origins, attributing caller-supplied immediates through
/// the wrapper's slot.
pub fn wrapper_pass(
	view: &ModuleView,
	text: &[u8],
	text_va: u64,
	bitness: u32,
	cfg: &ScanConfig,
	functions: &[(u64, u64)],
) -> Vec<Site> {
	let (mut sites, param_sites) = scan_text_with_params(view, text, text_va, bitness, cfg);

	let mut wrappers: Vec<(u64, u64)> = Vec::new();
	for p in param_sites {
		if let Some(&(start, _)) = functions.iter().find(|&&(s, e)| p.va >= s && p.va < e)
			&& !wrappers.contains(&(start, p.slot))
		{
			wrappers.push((start, p.slot));
		}
	}

	if !wrappers.is_empty() {
		let cfg2 = ScanConfig {
			wrappers,
			..cfg.clone()
		};
		sites.extend(scan_text(view, text, text_va, bitness, &cfg2));
		sites.sort_unstable_by_key(|s| (s.hash, s.slot, s.va));
		sites.dedup_by_key(|s| (s.hash, s.slot, s.va));
	}
	sites
}

/// Tracked register content.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Val {
	/// The imported leaf function pointer (mov reg, [rip+IAT]).
	LeafFn,
	/// The CCommandLine object pointer.
	Obj,
	/// The object's vtable pointer ([obj]).
	Vtable,
	/// A token-method function pointer loaded from vtable+slot.
	SlotFn(u64),
	/// A known immediate (hash constants, zero, murmur results).
	Imm(u64),
	/// Address of a (potential) string literal (lea reg, [rip+X]).
	Str(u64),
}

enum Dispatch {
	TokenSite(u64),
	MurmurOrExport,
	Other,
}

fn is_direct_branch(ins: &Instruction) -> bool {
	matches!(
		ins.op0_kind(),
		OpKind::NearBranch64 | OpKind::NearBranch32 | OpKind::NearBranch16
	)
}

/// Does the indirect call at `idx` return the command line object? True
/// when the next few instructions dereference RAX as a vtable holder:
/// `mov T, [rax]` with no intervening call.
fn callret_is_object(insns: &[Instruction], idx: usize) -> bool {
	for k in 1..=3usize {
		let Some(n) = insns.get(idx + k) else { return false };
		if n.mnemonic() == Mnemonic::Mov
			&& n.op0_kind() == OpKind::Register
			&& base(n.op0_register()) != Register::RAX
			&& n.op1_kind() == OpKind::Memory
			&& base(n.memory_base()) == Register::RAX
			&& n.memory_displacement64() == 0
		{
			return true;
		}
		if n.mnemonic() == Mnemonic::Call {
			return false;
		}
	}
	false
}

fn is_plausible_token(hash: u64) -> bool {
	if !(0x10_0000..u64::from(u32::MAX)).contains(&hash) {
		return false;
	}
	let bits = hash.count_ones();
	if bits < 6 {
		return false;
	}
	let b = (hash as u32).to_le_bytes();
	if b.iter().all(|&c| c.is_ascii_graphic()) {
		return false;
	}
	!matches!(hash, 832_154_671 | 1_977_497_166 | 2_000_000)
}

/// Does this mnemonic overwrite its first operand?
fn writes_op0(ins: &Instruction) -> bool {
	!matches!(
		ins.mnemonic(),
		Mnemonic::Cmp
			| Mnemonic::Test
			| Mnemonic::Push
			| Mnemonic::Nop
			| Mnemonic::Prefetcht0
			| Mnemonic::Prefetcht1
			| Mnemonic::Prefetcht2
			| Mnemonic::Prefetchnta
			| Mnemonic::Prefetchw
			| Mnemonic::Cmovo
			| Mnemonic::Cmovno
			| Mnemonic::Cmovb
			| Mnemonic::Cmovae
			| Mnemonic::Cmove
			| Mnemonic::Cmovne
			| Mnemonic::Cmovbe
			| Mnemonic::Cmova
			| Mnemonic::Cmovs
			| Mnemonic::Cmovns
			| Mnemonic::Cmovp
			| Mnemonic::Cmovnp
			| Mnemonic::Cmovl
			| Mnemonic::Cmovge
			| Mnemonic::Cmovle
			| Mnemonic::Cmovg
	)
}

/// Walks backward from the origin, seeding register immediates that were
/// set (and not overwritten) just before it. For each register only the
/// last write matters; a call kills caller-saved seeds older than it.
fn preseed(prev: &[Instruction], st: &mut HashMap<Register, Val>) {
	const VOLATILE: [Register; 7] = [
		Register::RAX,
		Register::RCX,
		Register::RDX,
		Register::R8,
		Register::R9,
		Register::R10,
		Register::R11,
	];
	let mut settled = std::collections::HashSet::new();
	let mut seeded: Vec<Register> = Vec::new();
	for ins in prev.iter().rev().take(12) {
		if ins.mnemonic() == Mnemonic::Call {
			for reg in VOLATILE {
				if seeded.contains(&reg) {
					st.remove(&reg);
					seeded.retain(|r| *r != reg);
				}
				settled.insert(reg);
			}
			continue;
		}
		if ins.op0_kind() != OpKind::Register {
			continue;
		}
		let dst = base(ins.op0_register());
		if !settled.insert(dst) {
			continue; // already know this register's fate
		}
		if !st.contains_key(&dst) && ins.mnemonic() == Mnemonic::Mov && is_imm_op(ins.op1_kind()) {
			st.insert(dst, Val::Imm(ins.immediate64()));
			seeded.push(dst);
		}
	}
}
fn apply_mov(ins: &Instruction, st: &mut HashMap<Register, Val>) {
	if ins.op0_kind() != OpKind::Register {
		return; // memory store, irrelevant
	}
	let dst = base(ins.op0_register());
	match ins.op1_kind() {
		OpKind::Immediate8
		| OpKind::Immediate8to16
		| OpKind::Immediate8to32
		| OpKind::Immediate8to64
		| OpKind::Immediate16
		| OpKind::Immediate32
		| OpKind::Immediate64 => {
			st.insert(dst, Val::Imm(ins.immediate64()));
		}
		OpKind::Register => {
			let src = base(ins.op1_register());
			if let Some(v) = st.get(&src) {
				st.insert(dst, *v);
			} else {
				st.remove(&dst);
			}
		}
		OpKind::Memory => {
			if ins.is_ip_rel_memory_operand() {
				st.remove(&dst);
			} else {
				let b = base(ins.memory_base());
				let disp = ins.memory_displacement64();
				let next = match st.get(&b) {
					Some(Val::Obj) if disp == 0 => Some(Val::Vtable),
					Some(Val::Obj) | Some(Val::Vtable) => {
						token_method(disp).map(|_| Val::SlotFn(disp))
					}
					_ => None,
				};
				match next {
					Some(v) => st.insert(dst, v),
					None => st.remove(&dst),
				};
			}
		}
		_ => {
			st.remove(&dst);
		}
	}
}

fn apply_lea(ins: &Instruction, st: &mut HashMap<Register, Val>, global_vas: &[u64]) {
	if ins.op0_kind() != OpKind::Register || ins.op1_kind() != OpKind::Memory {
		return;
	}
	let dst = base(ins.op0_register());
	if ins.is_ip_rel_memory_operand() {
		let target = ins.ip_rel_memory_address();
		if global_vas.contains(&target) {
			st.insert(dst, Val::Obj);
		} else {
			st.insert(dst, Val::Str(target));
		}
	} else if base(ins.memory_base()) != Register::None {
		if ins.memory_displacement64() == 0 && st.get(&base(ins.memory_base())) == Some(&Val::Obj) {
			st.insert(dst, Val::Obj);
		} else {
			st.remove(&dst);
		}
	} else {
		st.remove(&dst);
	}
}

fn dispatch(ins: &Instruction, st: &HashMap<Register, Val>) -> Dispatch {
	match ins.op0_kind() {
		OpKind::Memory => {
			if base(ins.memory_base()) != Register::None {
				let b = base(ins.memory_base());
				let disp = ins.memory_displacement64();
				if st.get(&b) == Some(&Val::Vtable) && token_method(disp).is_some() {
					return Dispatch::TokenSite(disp);
				}
			}
			Dispatch::Other
		}
		OpKind::Register => match st.get(&base(ins.op0_register())) {
			Some(Val::SlotFn(d)) if token_method(*d).is_some() => Dispatch::TokenSite(*d),
			_ => Dispatch::Other,
		},
		OpKind::NearBranch64 | OpKind::NearBranch32 | OpKind::NearBranch16 => {
			Dispatch::MurmurOrExport
		}
		_ => Dispatch::Other,
	}
}

fn apply_call_effects(
	ins: &Instruction,
	st: &mut HashMap<Register, Val>,
	view: &ModuleView,
	cfg: &ScanConfig,
	murmur_names: &mut HashMap<u64, String>,
) {
	if ins.mnemonic() != Mnemonic::Call {
		return;
	}

	let rcx_val = st.get(&Register::RCX).copied();

	for reg in [
		Register::RAX,
		Register::RCX,
		Register::RDX,
		Register::R8,
		Register::R9,
		Register::R10,
		Register::R11,
	] {
		st.remove(&reg);
	}

	if is_direct_branch(ins) {
		let target = ins.near_branch_target();
		if cfg.murmur_vas.contains(&target)
			&& let Some(Val::Str(va)) = rcx_val
			&& let Some(s) = view.read_cstr(va)
		{
			let hash = u64::from(token_hash(&s));
			st.insert(Register::RAX, Val::Imm(hash));
			murmur_names.entry(hash).or_insert(s);
		} else if cfg.export_vas.contains(&target) {
			st.insert(Register::RAX, Val::Obj);
		}
	}
}

fn base(reg: Register) -> Register {
	match reg {
		Register::AL | Register::AH | Register::AX | Register::EAX | Register::RAX => Register::RAX,
		Register::CL | Register::CH | Register::CX | Register::ECX | Register::RCX => Register::RCX,
		Register::DL | Register::DH | Register::DX | Register::EDX | Register::RDX => Register::RDX,
		Register::BL | Register::BH | Register::BX | Register::EBX | Register::RBX => Register::RBX,
		Register::SPL | Register::SP | Register::ESP | Register::RSP => Register::RSP,
		Register::BPL | Register::BP | Register::EBP | Register::RBP => Register::RBP,
		Register::SIL | Register::SI | Register::ESI | Register::RSI => Register::RSI,
		Register::DIL | Register::DI | Register::EDI | Register::RDI => Register::RDI,
		Register::R8L | Register::R8W | Register::R8D | Register::R8 => Register::R8,
		Register::R9L | Register::R9W | Register::R9D | Register::R9 => Register::R9,
		Register::R10L | Register::R10W | Register::R10D | Register::R10 => Register::R10,
		Register::R11L | Register::R11W | Register::R11D | Register::R11 => Register::R11,
		Register::R12L | Register::R12W | Register::R12D | Register::R12 => Register::R12,
		Register::R13L | Register::R13W | Register::R13D | Register::R13 => Register::R13,
		Register::R14L | Register::R14W | Register::R14D | Register::R14 => Register::R14,
		Register::R15L | Register::R15W | Register::R15D | Register::R15 => Register::R15,
		_ => reg,
	}
}

/// Decodes the `lea reg, [rip+X]` (followed by `ret`) shape of tier0's
/// `CommandLine` leaf and returns the referenced object VA.
pub fn leaf_lea_target(view: &ModuleView, fn_va: u64, bitness: u32) -> Option<u64> {
	let off = view.va_to_offset(fn_va)?;
	let bytes = &view.buffer[off..off.saturating_add(16).min(view.buffer.len())];
	let mut decoder = Decoder::with_ip(bitness, bytes, fn_va, DecoderOptions::NONE);
	let mut ins = Instruction::default();
	let mut decoded = 0;
	while decoder.can_decode() && decoded < 4 {
		decoder.decode_out(&mut ins);
		decoded += 1;
		match ins.mnemonic() {
			Mnemonic::Lea if ins.is_ip_rel_memory_operand() => {
				let target = ins.ip_rel_memory_address();
				let mut next = Instruction::default();
				if decoder.can_decode() {
					decoder.decode_out(&mut next);
					if next.mnemonic() == Mnemonic::Ret {
						return Some(target);
					}
				}
				return None;
			}
			Mnemonic::Ret => return None,
			_ => {}
		}
	}
	None
}

/// Parses `.pdata` RUNTIME_FUNCTION entries into (start, end) VA pairs.
pub fn parse_pdata(view: &ModuleView, pdata: &[u8], image_base: u64) -> Vec<(u64, u64)> {
	let _ = view;
	pdata
		.as_chunks::<12>()
		.0
		.iter()
		.filter_map(|c| {
			let start = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
			let end = u32::from_le_bytes([c[4], c[5], c[6], c[7]]);
			(start < end).then(|| (image_base + u64::from(start), image_base + u64::from(end)))
		})
		.collect()
}

/// Finds murmur-hash helper functions: functions whose bytes contain at
/// least `min_hits` little-endian occurrences of the 0x5BD1E995 constant.
pub fn find_murmur_fns(
	text: &[u8],
	text_va: u64,
	functions: &[(u64, u64)],
	min_hits: usize,
) -> Vec<u64> {
	const NEEDLE: [u8; 4] = 0x5BD1_E995u32.to_le_bytes();
	functions
		.iter()
		.filter(|(start, end)| {
			let s = (*start - text_va) as usize;
			let e = (*end - text_va) as usize;
			if e > text.len() || s >= e {
				return false;
			}
			let mut hits = 0;
			let hay = &text[s..e];
			let mut i = 0;
			while let Some(pos) = hay[i..].windows(4).position(|w| w == NEEDLE) {
				hits += 1;
				i += pos + 1;
				if hits >= min_hits {
					return true;
				}
			}
			false
		})
		.map(|&(start, _)| start)
		.collect()
}

/// Value classification of a token method, refined by the R8 (ppszValue)
/// state at a CheckParm call site: a non-null out pointer means the caller
/// reads the argument after the token.
// CheckParm's ppszValue (R8) distinguishes presence-only from value reads
fn value_of_method(method: Option<TokenMethod>, r8: Option<&Val>) -> Option<bool> {
	match method? {
		TokenMethod::ParmValueBuffer
		| TokenMethod::ParmValueFloat
		| TokenMethod::ParmValueInt
		| TokenMethod::ParmValueCStr => Some(true),
		TokenMethod::HasParm | TokenMethod::FindParm => Some(false),
		TokenMethod::CheckParm => match r8 {
			Some(Val::Imm(0)) => Some(false),
			Some(_) => Some(true),
			None => None,
		},
	}
}

/// Whether a conditional jump leaves the block when its tested operand was
/// zero ("jump on false"), the short-circuit shape of `a && b`, or when
/// it was non-zero ("jump on true"), the shape of `a || b`.
fn jump_flavor(ins: &Instruction) -> Option<bool> {
	match ins.mnemonic() {
		Mnemonic::Je | Mnemonic::Jbe | Mnemonic::Jl => Some(true),
		Mnemonic::Jne | Mnemonic::Ja | Mnemonic::Jg => Some(false),
		_ => None,
	}
}

/// The first conditional jump that consumes a call's RAX result: a
/// `test rax, rax` / `cmp rax, 0` followed by a branch, with nothing else
/// clobbering RAX in between.
fn consuming_jcc(insns: &[Instruction], idx: usize) -> Option<&Instruction> {
	for ins in insns.iter().skip(idx + 1).take(6) {
		match ins.mnemonic() {
			Mnemonic::Test
				if ins.op0_kind() == OpKind::Register
					&& base(ins.op0_register()) == Register::RAX
					&& ins.op1_kind() == OpKind::Register
					&& base(ins.op1_register()) == Register::RAX => {}
			Mnemonic::Cmp
				if ins.op0_kind() == OpKind::Register
					&& base(ins.op0_register()) == Register::RAX
					&& is_imm_op(ins.op1_kind())
					&& ins.immediate64() == 0 => {}
			Mnemonic::Je | Mnemonic::Jne | Mnemonic::Ja | Mnemonic::Jg | Mnemonic::Jbe | Mnemonic::Jl => {
				return Some(ins);
			}
			_ => {
				if ins.op0_kind() == OpKind::Register
					&& base(ins.op0_register()) == Register::RAX
					&& writes_op0(ins)
				{
					return None;
				}
			}
		}
	}
	None
}

/// Detects how token checks in the same function combine: `a && b`
/// (Requires), `a || b` (Alternative) or `a && !b` (Negates).
pub fn relations_pass(
	view: &ModuleView,
	text: &[u8],
	text_va: u64,
	bitness: u32,
	functions: &[(u64, u64)],
	sites: &[Site],
) -> Vec<SiteRelation> {
	if sites.len() < 2 {
		return Vec::new();
	}

	let mut relations = Vec::new();

	let mut by_fn: HashMap<(u64, u64), Vec<&Site>> = HashMap::new();
	for site in sites {
		if let Some(&(start, end)) = functions.iter().find(|&&(s, e)| site.va >= s && site.va < e) {
			by_fn.entry((start, end)).or_default().push(site);
		}
	}

	for ((start, end), mut fn_sites) in by_fn {
		if fn_sites.len() < 2 {
			continue;
		}
		fn_sites.sort_unstable_by_key(|s| s.va);

		let Some(off) = view.va_to_offset(start) else {
			continue;
		};
		let len = (end - start) as usize;
		let bytes = &view.buffer[off..(off + len).min(view.buffer.len())];
		let mut decoder = Decoder::with_ip(bitness, bytes, start, DecoderOptions::NONE);
		let mut insns = Vec::with_capacity(bytes.len() / 4);
		while decoder.can_decode() {
			let mut ins = Instruction::default();
			decoder.decode_out(&mut ins);
			insns.push(ins);
		}
		let find = |va: u64| insns.iter().position(|i| i.ip() == va);

		for w in 0..fn_sites.len().saturating_sub(1) {
			let earlier = fn_sites[w];
			let later = &fn_sites[w + 1];
			let Some(idx) = find(earlier.va) else { continue };
			let Some(jcc) = consuming_jcc(&insns, idx) else { continue };
			let Some(flavor) = jump_flavor(jcc) else { continue };
			let target = jcc.near_branch_target();
			if target <= later.va || target >= end {
				continue;
			}
			let later_flavor = find(later.va)
				.and_then(|li| consuming_jcc(&insns, li))
				.and_then(|lj| (lj.near_branch_target() == target).then_some(jump_flavor(lj))?);
			let Some(later_flavor) = later_flavor else { continue };
			let relation = match (flavor, later_flavor) {
				(true, true) => Relation::Requires,
				(false, false) => Relation::Alternative,
				(_, _) => Relation::Negates,
			};
			relations.push(SiteRelation {
				earlier: earlier.hash,
				later: later.hash,
				relation,
				branch_va: jcc.ip(),
			});
		}
	}

	relations.sort_unstable();
	relations.dedup();
	relations
}

/// DLL names passed to LoadLibrary-family imports as string literals. A
/// call through a LoadLibrary IAT slot whose RCX was set by a `lea` of a
/// string is recorded; indirect names are not.
pub fn find_dynamic_loads(
	view: &ModuleView,
	text: &[u8],
	text_va: u64,
	bitness: u32,
	loadlibrary_iats: &[u64],
) -> Vec<String> {
	if loadlibrary_iats.is_empty() {
		return Vec::new();
	}

	let mut decoder = Decoder::with_ip(bitness, text, text_va, DecoderOptions::NONE);
	let mut insns = Vec::with_capacity(text.len() / 4);
	while decoder.can_decode() {
		let mut ins = Instruction::default();
		decoder.decode_out(&mut ins);
		insns.push(ins);
	}

	let mut names = Vec::new();
	for (idx, ins) in insns.iter().enumerate() {
		if ins.mnemonic() != Mnemonic::Call || !ins.is_ip_rel_memory_operand() {
			continue;
		}
		if !loadlibrary_iats.contains(&ins.ip_rel_memory_address()) {
			continue;
		}
		for b in insns[idx.saturating_sub(6)..idx].iter().rev() {
			if b.mnemonic() == Mnemonic::Lea
				&& b.is_ip_rel_memory_operand()
				&& b.op0_kind() == OpKind::Register
				&& base(b.op0_register()) == Register::RCX
			{
				if let Some(name) = view.read_cstr(b.ip_rel_memory_address()) {
					if name.contains('.') && name.len() < 64 {
						names.push(name.to_ascii_lowercase());
					}
				}
				break;
			}
			if b.op0_kind() == OpKind::Register
				&& base(b.op0_register()) == Register::RCX
				&& b.mnemonic() != Mnemonic::Nop
			{
				break;
			}
		}
	}
	names.sort();
	names.dedup();
	names
}

/// Discovers module-local globals that cache the CCommandLine object
/// pointer: a store to a rip-relative global whose value traces back to
/// a known origin (IAT call return, export call return, or the static
/// object). The global then becomes a valid origin for later reads.
// Module init: call [rip+IAT_CommandLine] -> mov [rip+cached_global], rax
// Later use: mov rcx, [rip+cached_global] -> vtable -> token slot call
// The tracker can't follow this without knowing the cached global VA.
pub fn discover_cached_globals(
	text: &[u8],
	text_va: u64,
	bitness: u32,
	cfg: &ScanConfig,
) -> Vec<u64> {
	let mut decoder = Decoder::with_ip(bitness, text, text_va, DecoderOptions::NONE);
	let mut insns = Vec::with_capacity(text.len() / 4);
	while decoder.can_decode() {
		let mut ins = Instruction::default();
		decoder.decode_out(&mut ins);
		insns.push(ins);
	}

	let mut globals = Vec::new();
	for (idx, ins) in insns.iter().enumerate() {
		if ins.mnemonic() != Mnemonic::Mov
			|| ins.op0_kind() != OpKind::Memory
			|| !ins.is_ip_rel_memory_operand()
			|| ins.op1_kind() != OpKind::Register
		{
			continue;
		}
		let store_target = ins.ip_rel_memory_address();
		let src = base(ins.op1_register());

		for b in insns[idx.saturating_sub(15)..idx].iter().rev() {
			if b.mnemonic() == Mnemonic::Call {
				break;
			}
			if b.is_ip_rel_memory_operand() && cfg.iat_vas.contains(&b.ip_rel_memory_address()) {
				if b.mnemonic() == Mnemonic::Call && src == Register::RAX {
					globals.push(store_target);
					break;
				}
			}
			if b.mnemonic() == Mnemonic::Lea
				&& b.is_ip_rel_memory_operand()
				&& cfg.global_vas.contains(&b.ip_rel_memory_address())
				&& base(b.op0_register()) == src
			{
				globals.push(store_target);
				break;
			}
			if b.mnemonic() == Mnemonic::Mov
				&& b.op0_kind() == OpKind::Register
				&& base(b.op0_register()) == src
				&& b.op1_kind() == OpKind::Register
				&& base(b.op1_register()) == Register::RAX
			{
				continue;
			}
		}
	}
	globals.sort_unstable();
	globals.dedup();
	globals
}

/// The token-slot displacement a call within a few instructions of `idx`
/// goes through, and that call's VA: either a direct
/// `call [reg + token_slot]` or a `call reg` where reg was loaded from
/// `[vtable + token_slot]` in between.
fn slot_call_near(insns: &[Instruction], idx: usize) -> Option<(u64, u64)> {
	let mut slot_fn_reg: Option<(Register, u64)> = None;
	for ins in insns.iter().skip(idx + 1).take(6) {
		match ins.mnemonic() {
			Mnemonic::Mov => {
				if ins.op0_kind() == OpKind::Register && ins.op1_kind() == OpKind::Memory {
					let disp = ins.memory_displacement64();
					if token_method(disp).is_some() {
						slot_fn_reg = Some((base(ins.op0_register()), disp));
					}
				}
			}
			Mnemonic::Call => match ins.op0_kind() {
				OpKind::Memory => {
					let disp = ins.memory_displacement64();
					if token_method(disp).is_some() {
						return Some((disp, ins.ip()));
					}
				}
				OpKind::Register => {
					let reg = base(ins.op0_register());
					if let Some((r, disp)) = slot_fn_reg {
						if r == reg {
							return Some((disp, ins.ip()));
						}
					}
				}
				_ => {}
			},
			_ => {}
		}
	}
	None
}

/// Post-pass: marks inlined-helper copies and recovers call sites of
/// known tokens the origin tracker missed.
// Recover missed call sites of known tokens: the tracker needs an origin
// chain, but the token immediate + token-slot call shape is enough when
// the hash is already proven to be a launch option.
pub fn post_pass(
	text: &[u8],
	text_va: u64,
	bitness: u32,
	functions: &[(u64, u64)],
	sites: &mut Vec<Site>,
) {
	let mut decoder = Decoder::with_ip(bitness, text, text_va, DecoderOptions::NONE);
	let mut insns = Vec::with_capacity(text.len() / 4);
	while decoder.can_decode() {
		let mut ins = Instruction::default();
		decoder.decode_out(&mut ins);
		insns.push(ins);
	}

	let known: HashSet<(u64, u64)> = sites.iter().map(|s| (s.hash, s.va)).collect();
	let known_hashes: HashSet<u64> = sites.iter().map(|s| s.hash).collect();
	for (idx, ins) in insns.iter().enumerate() {
		if ins.mnemonic() != Mnemonic::Mov
			|| ins.op0_kind() != OpKind::Register
			|| base(ins.op0_register()) != Register::RDX
			|| !is_imm_op(ins.op1_kind())
		{
			continue;
		}
		let hash = ins.immediate64();
		if !known_hashes.contains(&hash) {
			continue;
		}
		let Some((slot, call_va)) = slot_call_near(&insns, idx) else {
			continue;
		};
		if known.contains(&(hash, call_va)) {
			continue;
		}
		sites.push(Site {
			hash,
			slot,
			method: token_method(slot),
			va: call_va,
			name: None,
			value: value_of_method(token_method(slot), None),
			inlined: false,
		});
	}

	let index_of = |va: u64| insns.iter().position(|i| i.ip() == va);
	let fn_of = |va: u64| functions.iter().find(|&&(s, e)| va >= s && va < e);
	let mut groups: HashMap<(u64, String), Vec<u64>> = HashMap::new();
	for site in sites.iter() {
		let Some(idx) = index_of(site.va) else { continue };
		let start = idx.saturating_sub(5);
		let shape: String = insns[start..=idx]
			.iter()
			.map(|i| format!("{:?}|", i.mnemonic()))
			.collect();
		groups.entry((site.hash, shape)).or_default().push(site.va);
	}
	let mut inlined_vas: HashSet<u64> = HashSet::new();
	for vas in groups.values() {
		let distinct_fns = vas.iter().filter_map(|&va| fn_of(va).map(|f| f.0)).collect::<HashSet<_>>();
		if vas.len() >= 3 && distinct_fns.len() >= 3 {
			inlined_vas.extend(vas);
		}
	}
	for site in sites.iter_mut() {
		if inlined_vas.contains(&site.va) {
			site.inlined = true;
		}
	}

	sites.sort_unstable_by_key(|s| (s.hash, s.slot, s.va));
	sites.dedup_by_key(|s| (s.hash, s.slot, s.va));
}

#[cfg(test)]
mod tests {
	use super::*;

	const BITNESS: u32 = 64;
	const BASE: u64 = 0x1000_0000;
	fn view_with_rdata(rdata_va: u64, rdata: &[u8]) -> ModuleView<'_> {
		ModuleView {
			buffer: rdata,
			image_base: BASE,
			sections: vec![SectionMap {
				va: rdata_va - BASE,
				vsize: rdata.len() as u64,
				raw_offset: 0,
				raw_size: rdata.len(),
			}],
		}
	}

	/// Real tier0 bytes at 0x180045A88 (self-call through the export).
	/// call CommandLine; mov rcx,rax; mov rdx,[rax]; mov r8,[rdx+0x20];
	/// mov edx,0xBEAE8FB6; call r8   ->  -clearassertstate via HasParm.
	#[test]
	fn tier0_export_call_site_is_found() {
		let text_va = BASE + 0x1000;
		let export_va = BASE + 0x5C130;
		let rel = (export_va - (text_va + 5)) as i32;
		let mut text = vec![0xE8];
		text.extend_from_slice(&rel.to_le_bytes());
		text.extend_from_slice(&[
			0x48, 0x8B, 0xC8, // mov rcx, rax
			0x48, 0x8B, 0x10, // mov rdx, [rax]
			0x4C, 0x8B, 0x42, 0x20, // mov r8, [rdx+0x20]
			0xBA, 0xB6, 0x8F, 0xAE, 0xBE, // mov edx, 0xBEAE8FB6
			0x41, 0xFF, 0xD0, // call r8
		]);
		let view = view_with_rdata(BASE + 0x9000, &[0]);
		let cfg = ScanConfig {
			export_vas: vec![export_va],
			window: 60,
			..ScanConfig::default()
		};
		let sites = scan_text(&view, &text, text_va, BITNESS, &cfg);
		assert_eq!(sites.len(), 1, "expected exactly one site, got {sites:?}");
		assert_eq!(sites[0].hash, 0xBEAE_8FB6);
		assert_eq!(sites[0].slot, 0x20);
		assert_eq!(sites[0].method, Some(TokenMethod::HasParm));
	}

	/// Real engine2 bytes at 0x180140F74 (IAT form):
	/// call [rip+IAT]; mov edx,0x43C83042; mov rcx,rax; mov r8,[rax];
	/// call [r8+0x20].
	#[test]
	fn engine2_iat_call_site_is_found() {
		let text_va = BASE + 0x2000;
		let iat_va = text_va + 6 + 0x34_BC46;
		let mut text = vec![0xFF, 0x15];
		text.extend_from_slice(&0x34_BC46u32.to_le_bytes());
		text.extend_from_slice(&[
			0xBA, 0x42, 0x30, 0xC8, 0x43, // mov edx, 0x43C83042
			0x48, 0x8B, 0xC8, // mov rcx, rax
			0x4C, 0x8B, 0x00, // mov r8, [rax]
			0x41, 0xFF, 0x50, 0x20, // call [r8+0x20]
		]);
		let view = view_with_rdata(BASE + 0x9000, &[0]);
		let cfg = ScanConfig {
			iat_vas: vec![iat_va],
			window: 60,
			..ScanConfig::default()
		};
		let sites = scan_text(&view, &text, text_va, BITNESS, &cfg);
		assert_eq!(sites.len(), 1, "expected exactly one site, got {sites:?}");
		assert_eq!(sites[0].hash, 0x43C8_3042);
		assert_eq!(sites[0].slot, 0x20);
	}

	/// Fully inlined access: lea rbx,[rip+obj]; mov rax,[rbx];
	/// mov edx,imm; call [rax+0x18]: no call to CommandLine at all.
	#[test]
	fn global_ref_origin_is_tracked() {
		let text_va = BASE + 0x3000;
		let obj_va = BASE + 0x3AC590;
		let disp = (obj_va - (text_va + 7)) as i32;
		let mut text = vec![0x48, 0x8D, 0x1D]; // lea rbx, [rip+disp]
		text.extend_from_slice(&disp.to_le_bytes());
		text.extend_from_slice(&[
			0x48, 0x8B, 0x03, // mov rax, [rbx]
			0xBA, 0x86, 0x28, 0x24, 0x0C, // mov edx, 0x0C242886
			0xFF, 0x50, 0x18, // call [rax+0x18]
		]);
		let view = view_with_rdata(BASE + 0x9000, &[0]);
		let cfg = ScanConfig {
			global_vas: vec![obj_va],
			window: 60,
			..ScanConfig::default()
		};
		let sites = scan_text(&view, &text, text_va, BITNESS, &cfg);
		assert_eq!(sites.len(), 1, "expected exactly one site, got {sites:?}");
		assert_eq!(sites[0].hash, 0x0C24_2886);
		assert_eq!(sites[0].slot, 0x18);
	}

	/// Noise control: a token-looking immediate feeding an indirect call
	/// with no CommandLine object lineage must NOT be recorded. This is
	/// the structural replacement for the old blocklist (27015, FourCCs,
	/// the famous `7`, ...).
	#[test]
	fn unrelated_indirect_calls_are_ignored() {
		let text: Vec<u8> = [
			&[0xBA, 0x79, 0x69, 0x00, 0x00][..], // mov edx, 27015
			&[0x48, 0x8B, 0x03][..],             // mov rax, [rbx]
			&[0xFF, 0x50, 0x08][..],             // call [rax+0x08]
			&[0xBA, 0x07, 0x00, 0x00, 0x00][..], // mov edx, 7
			&[0x48, 0x8B, 0x0B][..],             // mov rcx, [rbx]
			&[0x41, 0xFF, 0x51, 0x18][..],       // call [r9+0x18]
		]
		.into_iter()
		.flatten()
		.copied()
		.collect();
		let view = view_with_rdata(BASE + 0x9000, &[0]);
		let cfg = ScanConfig::with_window(60);
		assert!(scan_text(&view, &text, BASE + 0x4000, BITNESS, &cfg).is_empty());
	}

	/// Real rendersystemdx11 bytes at 0x180011FA4 (runtime-hashed literal):
	/// lea rcx,[rip+"-rtest1"]; call murmur; mov edx,eax; mov rcx,rsi;
	/// call rdi  where rdi was loaded from [vtable+0x90] before the lea.
	#[test]
	fn murmur_runtime_hash_recovers_the_name() {
		let text_va = BASE + 0x5000;
		let str_va = BASE + 0x9000;
		let murmur_va = BASE + 0x6000;
		let obj_va = BASE + 0x7C000;
		let gdisp = (obj_va - (text_va + 7)) as i32;
		let mut text = vec![0x48, 0x8D, 0x35];
		text.extend_from_slice(&gdisp.to_le_bytes());
		text.extend_from_slice(&[
			0x48, 0x8B, 0x06, // +0x07 mov rax, [rsi]
			0x48, 0x8B, 0xB8, 0x90, 0x00, 0x00, 0x00, // +0x0A mov rdi, [rax+0x90]
		]);
		let sdisp = (str_va - (text_va + 0x11 + 7)) as i32;
		text.extend_from_slice(&[0x48, 0x8D, 0x0D]);
		text.extend_from_slice(&sdisp.to_le_bytes());
		let rel = (murmur_va - (text_va + 0x18 + 5)) as i32;
		text.extend_from_slice(&[0xE8]);
		text.extend_from_slice(&rel.to_le_bytes());
		text.extend_from_slice(&[
			0x8B, 0xD0, // mov edx, eax
			0x48, 0x8B, 0xCE, // mov rcx, rsi
			0xFF, 0xD7, // call rdi
		]);
		let rdata = b"-rtest1\0";
		let view = view_with_rdata(str_va, rdata);
		let cfg = ScanConfig {
			global_vas: vec![obj_va],
			murmur_vas: vec![murmur_va],
			window: 60,
			..ScanConfig::default()
		};
		let sites = scan_text(&view, &text, text_va, BITNESS, &cfg);
		assert_eq!(sites.len(), 1, "expected exactly one site, got {sites:?}");
		assert_eq!(sites[0].hash, u64::from(token_hash("-rtest1")));
		assert_eq!(sites[0].slot, 0x90);
		assert_eq!(sites[0].method, Some(TokenMethod::HasParm));
		assert_eq!(sites[0].name.as_deref(), Some("-rtest1"));
	}

	/// tier0's real leaf bytes at 0x18005C130:
	/// lea rax, [rip+0x350459]; ret  -> object at 0x1803AC590.
	#[test]
	fn leaf_lea_target_finds_the_object() {
		let leaf: &[u8] = &[0x48, 0x8D, 0x05, 0x59, 0x04, 0x35, 0x00, 0xC3];
		let view = view_with_rdata(BASE + 0x5C130, leaf);
		assert_eq!(
			leaf_lea_target(&view, BASE + 0x5C130, BITNESS),
			Some(BASE + 0x3AC590)
		);
	}

	#[test]
	fn pdata_entries_parse_to_ranges() {
		let mut pdata = Vec::new();
		for (s, e) in [(0x1010u32, 0x10A0u32), (0x10B0u32, 0x1100u32)] {
			pdata.extend_from_slice(&s.to_le_bytes());
			pdata.extend_from_slice(&e.to_le_bytes());
			pdata.extend_from_slice(&0x2000u32.to_le_bytes());
		}
		let view = view_with_rdata(BASE + 0x9000, &[0]);
		let fns = parse_pdata(&view, &pdata, BASE);
		assert_eq!(
			fns,
			vec![
				(BASE + 0x1010, BASE + 0x10A0),
				(BASE + 0x10B0, BASE + 0x1100)
			]
		);
	}

	#[test]
	fn murmur_fns_are_found_by_constant_density() {
		let text_va = BASE + 0x1000;
		let mut text = vec![0u8; 0x1140];
		for off in [0x10usize, 0x40, 0x70] {
			text[off..off + 4].copy_from_slice(&0x5BD1_E995u32.to_le_bytes());
		}
		text[0x120..0x124].copy_from_slice(&0x5BD1_E995u32.to_le_bytes());
		let fns = vec![
			(text_va, text_va + 0x80),
			(text_va + 0x100, text_va + 0x140),
		];
		assert_eq!(find_murmur_fns(&text, text_va, &fns, 3), vec![text_va]);
	}

	/// Real tier0 shape at 0x180141E94 (-debug_exitprocess, hash
	/// 0xBAEF6004): the object register survives a conditional move and a
	/// null guard before the token call.
	/// lea rbx,[rip+obj]; cmove rbx, r14; test rbx,rbx; je over;
	/// mov rax,[rbx]; mov edx,imm; mov rcx,rbx; call [rax+0x20].
	#[test]
	fn object_survives_cmovcc_and_null_guard() {
		let text_va = BASE + 0x6000;
		let obj_va = BASE + 0x3AC590;
		let disp = (obj_va - (text_va + 7)) as i32;
		let mut text = vec![0x48, 0x8D, 0x1D]; // lea rbx, [rip+disp]
		text.extend_from_slice(&disp.to_le_bytes());
		text.extend_from_slice(&[
			0x49, 0x0F, 0x44, 0xDE, // cmove rbx, r14
			0x48, 0x85, 0xDB, // test rbx, rbx
			0x74, 0x08, // je +8 (skip the call)
			0x48, 0x8B, 0x03, // mov rax, [rbx]
			0xBA, 0x04, 0x60, 0xEF, 0xBA, // mov edx, 0xBAEF6004
			0x48, 0x8B, 0xCB, // mov rcx, rbx
			0xFF, 0x50, 0x20, // call [rax+0x20]
		]);
		let view = view_with_rdata(BASE + 0x9000, &[0]);
		let cfg = ScanConfig {
			global_vas: vec![obj_va],
			window: 60,
			..ScanConfig::default()
		};
		let sites = scan_text(&view, &text, text_va, BITNESS, &cfg);
		assert_eq!(sites.len(), 1, "expected one site, got {sites:?}");
		assert_eq!(sites[0].hash, 0xBAEF_6004);
		assert_eq!(sites[0].slot, 0x20);
	}

	/// Real tier0 shape at 0x18017A00B (-enable_fast_stall_monitor, hash
	/// 0xF77D873F): the token immediate is loaded BEFORE the object
	/// (vtable) is acquired, with stores in between.
	#[test]
	fn token_loaded_before_origin_is_seeded() {
		let text_va = BASE + 0x7000;
		let obj_va = BASE + 0x3AC590;
		let disp = (obj_va - (text_va + 0x19 + 7)) as i32;
		let mut text = vec![
			0xBA, 0x3F, 0x87, 0x7D, 0xF7, // +0x00 mov edx, 0xF77D873F
			0x48, 0x89, 0xB3, 0x60, 0x03, 0x00, 0x00, // +0x05 mov [rbx+0x360], rsi
			0x89, 0xAB, 0x0C, 0x00, 0x00, 0x00, // +0x0C mov [rbx+0xC], ebp
			0x48, 0x89, 0xB3, 0x10, 0x00, 0x00, 0x00, // +0x12 mov [rbx+0x10], rsi
		];
		text.extend_from_slice(&[0x48, 0x8B, 0x05]);
		text.extend_from_slice(&disp.to_le_bytes());
		text.extend_from_slice(&[
			0xFF, 0x50, 0x20, // +0x20 call [rax+0x20]
		]);
		let view = view_with_rdata(BASE + 0x9000, &[0]);
		let cfg = ScanConfig {
			global_vas: vec![obj_va],
			window: 60,
			..ScanConfig::default()
		};
		let sites = scan_text(&view, &text, text_va, BITNESS, &cfg);
		assert_eq!(sites.len(), 1, "expected one site, got {sites:?}");
		assert_eq!(sites[0].hash, 0xF77D_873F);
		assert_eq!(sites[0].slot, 0x20);
	}

	/// An immediate killed by an intervening call must not be seeded.
	#[test]
	fn token_killed_by_earlier_call_is_not_seeded() {
		let text_va = BASE + 0x8000;
		let obj_va = BASE + 0x3AC590;
		let disp = (obj_va - (text_va + 5 + 5 + 7)) as i32;
		let mut text = vec![
			0xBA, 0x3F, 0x87, 0x7D, 0xF7, // mov edx, 0xF77D873F
			0xE8, 0x00, 0x00, 0x00, 0x00, // call (clobbers RDX)
		];
		text.extend_from_slice(&[0x48, 0x8B, 0x05]);
		text.extend_from_slice(&disp.to_le_bytes());
		text.extend_from_slice(&[0xFF, 0x50, 0x20]); // call [rax+0x20]
		let view = view_with_rdata(BASE + 0x9000, &[0]);
		let cfg = ScanConfig {
			global_vas: vec![obj_va],
			window: 60,
			..ScanConfig::default()
		};
		assert!(scan_text(&view, &text, text_va, BITNESS, &cfg).is_empty());
	}

	/// Real assetsystem shape at 0x180088440 (hash 0x37B9FE95): the
	/// CCommandLine object is RETURNED by another interface's method
	/// (the "callv:0x88" getter), then used directly.
	/// call [rax+0x88]; mov edx,imm; mov rcx,[rax]; mov r8,[rcx+0x20];
	/// mov rcx,rax; call r8.
	#[test]
	fn callret_origin_tracks_getter_result() {
		let text_va = BASE + 0x9000;
		let text: Vec<u8> = [
			&[0x48, 0x8B, 0x03][..],              // mov rax, [rbx]
			&[0xFF, 0x90, 0x88, 0x00, 0x00, 0x00][..], // call [rax+0x88]  (getter, disp32)
			&[0xBA, 0x95, 0xFE, 0xB9, 0x37][..],  // mov edx, 0x37B9FE95
			&[0x48, 0x8B, 0x08][..],              // mov rcx, [rax]
			&[0x4C, 0x8B, 0x41, 0x20][..],        // mov r8, [rcx+0x20]
			&[0x48, 0x8B, 0xC8][..],              // mov rcx, rax
			&[0x41, 0xFF, 0xD0][..],              // call r8
		]
		.into_iter()
		.flatten()
		.copied()
		.collect();
		let view = view_with_rdata(BASE + 0xF000, &[0]);
		let cfg = ScanConfig::with_window(60);
		let sites = scan_text(&view, &text, text_va, BITNESS, &cfg);
		assert_eq!(sites.len(), 1, "expected one site, got {sites:?}");
		assert_eq!(sites[0].hash, 0x37B9_FE95);
		assert_eq!(sites[0].slot, 0x20);
	}

	/// Real vconsole2 shape (fn 0x1400246B0, hashes 1226158575 /
	/// 2959074205): the token sites are only reachable across an
	/// unconditional near jmp: the bytes after the jmp are another
	/// branch target. The window must continue through near-direct
	/// jumps (only indirect tail-jmps end tracking).
	#[test]
	fn window_continues_across_near_jmp() {
		let text_va = BASE + 0xA000;
		let iat_va = BASE + 0x60AF88;
		let disp = (iat_va - (text_va + 6)) as i32;
		let mut text = vec![0xFF, 0x15]; // call [rip+IAT]   -> rax = obj
		text.extend_from_slice(&disp.to_le_bytes());
		text.extend_from_slice(&[0x48, 0x8B, 0xF0]); // mov rsi, rax
		text.extend_from_slice(&[0xE9, 0x04, 0x00, 0x00, 0x00]);
		text.extend_from_slice(&[0x90, 0x90, 0x90, 0x90]); // other block's code
		text.extend_from_slice(&[
			0x48, 0x8B, 0x06, // mov rax, [rsi]
			0xBA, 0xEF, 0xB1, 0x15, 0x49, // mov edx, 0x4915B1EF
			0x48, 0x8B, 0xCE, // mov rcx, rsi
			0xFF, 0x50, 0x50, // call [rax+0x50]  int ParmValue
		]);
		let view = view_with_rdata(BASE + 0xF000, &[0]);
		let cfg = ScanConfig {
			iat_vas: vec![iat_va],
			window: 60,
			..ScanConfig::default()
		};
		let sites = scan_text(&view, &text, text_va, BITNESS, &cfg);
		assert_eq!(sites.len(), 1, "expected one site, got {sites:?}");
		assert_eq!(sites[0].hash, 0x4915_B1EF);
		assert_eq!(sites[0].slot, 0x50);
	}

	/// Structural noise rejects: flag constants (low popcount), FourCC
	/// tags (all printable ASCII), and verified non-CCommandLine hashes
	/// must never appear in the output.
	#[test]
	fn structural_noise_is_rejected() {
		let text_va = BASE + 0xB000;
		let iat_va = BASE + 0x60AF88;
		let disp = (iat_va - (text_va + 6)) as i32;
		let mut text = vec![0xFF, 0x15];
		text.extend_from_slice(&disp.to_le_bytes());
		text.extend_from_slice(&[
			0xBA, 0x20, 0x00, 0x00, 0x20, // mov edx, 0x20000020 (2 bits)
			0x48, 0x8B, 0xC8, // mov rcx, rax
			0x48, 0x8B, 0x00, // mov rax, [rcx]... wait need vtable first
		]);
		text.clear();

		assert!(!super::is_plausible_token(0x2000_0020), "2-bit flag constant");
		assert!(!super::is_plausible_token(0x4E45_5443), "FourCC NETC");
		assert!(!super::is_plausible_token(2_000_000), "sleep delay");
		assert!(!super::is_plausible_token(832_154_671), "IDebugVisualizer registry key");
		assert!(!super::is_plausible_token(1_977_497_166), "string-token sentinel");
		assert!(super::is_plausible_token(3_199_111_094), "-clearassertstate");
		assert!(super::is_plausible_token(197_456_290), "-tools");
		assert!(super::is_plausible_token(150_269_7765), "-testmode_hide_invalid_content_sync_problems");
	}
}
