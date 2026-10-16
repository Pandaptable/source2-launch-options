use cs_hash_reversal::scan::{
	command_line_exports, wrapper_pass, ModuleView, ScanConfig, SectionMap,
};

const BASE: u64 = 0x1000_0000;
const BITNESS: u32 = 64;

fn view_for(buffer: &[u8], va: u64, len: u64) -> ModuleView<'_> {
	ModuleView {
		buffer,
		image_base: BASE,
		sections: vec![SectionMap {
			va: va - BASE,
			vsize: len,
			raw_offset: 0,
			raw_size: buffer.len(),
		}],
	}
}

#[test]
fn picks_object_producing_exports_only() {
	let exports = [
		(
			"?V_SanitizeTextForCommandLine@@YAPEBDPEBDPEAVCBufferString@@_NH@Z",
			BASE + 0x15010,
		),
		("CommandLine", BASE + 0x5C130),
		("CreateCommandLine", BASE + 0x5C140),
		("FreeCommandLine", BASE + 0x5C210),
	];
	assert_eq!(
		command_line_exports(exports),
		vec![BASE + 0x5C130, BASE + 0x5C140]
	);
	assert_eq!(command_line_exports([("FreeCommandLine", BASE)]), vec![]);
}

/// Cached-getter propagation: wrapper W consumes a token parameter
/// (incoming EDX) at its internal HasParm site; caller C passes an
/// immediate. wrapper_pass must attribute C's immediate through W.
///
/// W:  call [rip+IAT]        ; rax = obj
///     mov rcx, rax
///     mov rdx, [rax]        ; vtable
///     mov r8, [rdx+0x20]    ; HasParm slot fn
///     call r8               ; token = incoming EDX (never written)
///     ret
/// C:  mov edx, 0x0C242886
///     call W
///     ret
#[test]
fn wrapper_call_propagates_caller_token() {
	let text_va = BASE + 0x1000;
	let iat_va = BASE + 0x60AF88;
	let w_va = text_va; // W starts at section start
	let c_va = text_va + 0x20;

	let mut text = Vec::new();
	let disp = (iat_va - (w_va + 6)) as i32;
	text.extend_from_slice(&[0xFF, 0x15]); // call [rip+IAT]
	text.extend_from_slice(&disp.to_le_bytes());
	text.extend_from_slice(&[
		0x48, 0x8B, 0xC8, // mov rcx, rax
		0x48, 0x8B, 0x10, // mov rdx, [rax]
		0x4C, 0x8B, 0x42, 0x20, // mov r8, [rdx+0x20]
		0x41, 0xFF, 0xD0, // call r8   <- param site, slot 0x20
		0xC3, // ret
	]);
	// pad to 0x20
	while text.len() < 0x20 {
		text.push(0xCC);
	}
	// --- C ---
	let wrel = ((w_va as i64) - (c_va as i64 + 10)) as i32;
	text.extend_from_slice(&[
		0xBA, 0x86, 0x28, 0x24, 0x0C, // mov edx, 0x0C242886
	]);
	text.extend_from_slice(&[0xE8]);
	text.extend_from_slice(&wrel.to_le_bytes());
	text.push(0xC3); // ret

	let fns = vec![(w_va, c_va), (c_va, c_va + 6 + 5)];
	let view = view_for(&text, text_va, text.len() as u64);
	let cfg = ScanConfig {
		iat_vas: vec![iat_va],
		window: 60,
		..ScanConfig::default()
	};
	let sites = wrapper_pass(&view, &text, text_va, BITNESS, &cfg, &fns);
	assert_eq!(
		sites.len(),
		1,
		"expected one propagated site, got {sites:?}"
	);
	assert_eq!(sites[0].hash, 0x0C24_2886);
	assert_eq!(sites[0].slot, 0x20);
	assert_eq!(sites[0].va, c_va + 5, "site VA should be the wrapper call");
}
