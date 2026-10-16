use anyhow::{Context, Result};
use cs_hash_reversal::scan::{
	ModuleView, ScanConfig, SectionMap, Site, command_line_exports, find_murmur_fns,
	leaf_lea_target, parse_pdata, wrapper_pass,
};
use goblin::pe::PE;
use goblin::pe::section_table::IMAGE_SCN_MEM_EXECUTE;
use std::collections::BTreeMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

fn main() -> Result<()> {
	let mut target_dir = String::new();
	let mut base_dir_arg = String::new();
	let mut output_dir_arg = String::from("./hashes");
	let mut debug_mode = false;

	let mut exclude_patterns: Vec<String> = vec!["import_scripts".to_string(), "csdm".to_string()];

	let mut args = env::args().skip(1);
	while let Some(arg) = args.next() {
		match arg.as_str() {
			"-debug" => debug_mode = true,
			"--base" => {
				if let Some(base) = args.next() {
					base_dir_arg = base;
				} else {
					println!("[-] Error: --base requires a directory name or path argument.");
					return Ok(());
				}
			}
			"--out" | "-o" => {
				if let Some(out) = args.next() {
					output_dir_arg = out;
				} else {
					println!("[-] Error: --out requires a directory path argument.");
					return Ok(());
				}
			}
			"--exclude" | "-e" => {
				if let Some(pattern) = args.next() {
					exclude_patterns.push(pattern);
				} else {
					println!("[-] Error: --exclude requires a pattern argument.");
					return Ok(());
				}
			}
			_ => {
				if target_dir.is_empty() {
					target_dir = arg;
				}
			}
		}
	}

	if target_dir.is_empty() || base_dir_arg.is_empty() {
		println!(
			"Usage: <executable> <target_dir> --base <base_folder> [--out <output_dir>] [--exclude <pattern>]... [-debug]"
		);
		println!(
			"Example: executable \"C:\\..\\game\\bin\\win64\" --base game --out ./my_results --exclude custom_folder"
		);
		println!("Note: Hardcoded exclusions: {:?}", exclude_patterns);
		return Ok(());
	}

	let target_dir_path = Path::new(&target_dir);

	println!("[*] Recursively scanning directory: {}", target_dir);
	println!("[*] Base directory set to: {}", base_dir_arg);
	println!("[*] Output directory set to: {}", output_dir_arg);
	println!("[*] Excluding paths containing: {:?}", exclude_patterns);
	if debug_mode {
		println!("[*] Debug mode enabled. Slot, method and addresses will be logged.");
	}

	let out_path = Path::new(&output_dir_arg);
	if out_path.exists() {
		println!(
			"[!] Output directory \"{}\" already exists. Files will be overwritten!",
			out_path.display()
		);
	} else {
		fs::create_dir_all(out_path).context("Failed to create output directory")?;
	}

	for entry in WalkDir::new(target_dir_path)
		.into_iter()
		.filter_map(|e| e.ok())
	{
		let path = entry.path();

		if path.is_file()
			&& matches!(
				path.extension().and_then(|s| s.to_str()),
				Some("dll" | "exe")
			) {
			let path_str = path.to_string_lossy();
			let should_exclude = exclude_patterns
				.iter()
				.any(|pattern| path_str.contains(pattern));

			if should_exclude {
				println!("[*] Skipping {} (matches exclude pattern)", path.display());
				continue;
			}

			println!("\n[*] Analyzing {}...", path.display());

			if let Err(e) = process_dll(
				path,
				target_dir_path,
				&base_dir_arg,
				&output_dir_arg,
				debug_mode,
			) {
				println!("[-] Failed to process {}: {}", path.display(), e);
			}
		}
	}

	println!(
		"\n[+] All done! Results saved to the {} directory.",
		output_dir_arg
	);
	Ok(())
}

fn process_dll(
	dll_path: &Path,
	target_dir: &Path,
	base_dir_arg: &str,
	output_dir_arg: &str,
	debug_mode: bool,
) -> Result<()> {
	let buffer = fs::read(dll_path)?;

	let pe = match PE::parse(&buffer) {
		Ok(pe) => pe,
		Err(_) => {
			println!("[-] Not a valid PE file, skipping.");
			return Ok(());
		}
	};

	let image_base = pe.image_base as u64;
	let bitness = if pe.is_64 { 64 } else { 32 };

	// Origins: the imported accessors (every module), tier0's own exports,
	// and the statically allocated CCommandLine object the leaf returns.
	// `CreateCommandLine` also returns a CCommandLine (a fresh one), which
	// vconsole2 uses to parse commands.
	let mut iat_vas = Vec::new();
	for import in pe.imports.iter() {
		if import.name.as_ref() == "CommandLine" || import.name.as_ref() == "CreateCommandLine" {
			iat_vas.push(image_base + import.offset as u64);
		}
	}
	let export_vas = command_line_exports(
		pe.exports
			.iter()
			.filter_map(|e| e.name.map(|n| (n, image_base + e.rva as u64))),
	);

	let mut global_vas = Vec::new();
	{
		let view = module_view(&pe, &buffer, image_base);
		for &eva in &export_vas {
			// Only the `CommandLine` accessor has the lea/ret leaf shape;
			// CreateCommandLine is a real function and will not match.
			if let Some(obj_va) = leaf_lea_target(&view, eva, bitness) {
				global_vas.push(obj_va);
			}
		}
	}

	if iat_vas.is_empty() && export_vas.is_empty() {
		println!("[-] No CommandLine import or export found. Skipping.");
		return Ok(());
	}

	let view = module_view(&pe, &buffer, image_base);

	// Function bounds from .pdata, used for murmur-helper discovery and
	// cached-getter (wrapper) propagation.
	let functions: Vec<(u64, u64)> = pe
		.sections
		.iter()
		.find(|s| s.name().map(|n| n.starts_with(".pdata")).unwrap_or(false))
		.map(|s| {
			let start = s.pointer_to_raw_data as usize;
			let size = s.size_of_raw_data as usize;
			let end = (start + size).min(buffer.len());
			parse_pdata(&view, &buffer[start..end], image_base)
		})
		.unwrap_or_default();
	let mut all_sites: Vec<Site> = Vec::new();

	for section in &pe.sections {
		if (section.characteristics & IMAGE_SCN_MEM_EXECUTE) == 0 {
			continue;
		}

		let start = section.pointer_to_raw_data as usize;
		let size = section.size_of_raw_data as usize;
		if start + size > buffer.len() {
			continue;
		}

		let section_data = &buffer[start..start + size];
		let section_va = image_base + section.virtual_address as u64;

		let section_fns: Vec<(u64, u64)> = functions
			.iter()
			.copied()
			.filter(|(s, e)| *s >= section_va && *e <= section_va + size as u64)
			.collect();

		let murmur_vas = find_murmur_fns(section_data, section_va, &section_fns, 3);

		let cfg = ScanConfig {
			iat_vas: iat_vas.clone(),
			export_vas: export_vas.clone(),
			global_vas: global_vas.clone(),
			murmur_vas,
			wrappers: Vec::new(),
			window: 120,
		};

		all_sites.extend(wrapper_pass(
			&view,
			section_data,
			section_va,
			bitness,
			&cfg,
			&functions,
		));
	}

	if all_sites.is_empty() {
		println!("[-] No hashes extracted.");
		return Ok(());
	}

	// One line per hash; sites collapse to the first occurrence.
	let mut by_hash: BTreeMap<u64, &Site> = BTreeMap::new();
	for site in &all_sites {
		by_hash.entry(site.hash).or_insert(site);
	}

	let filename = dll_path.file_name().unwrap_or_default().to_string_lossy();

	let mut relative_out_path = PathBuf::new();
	let base_path_arg = Path::new(base_dir_arg);

	if base_path_arg.is_absolute() && dll_path.starts_with(base_path_arg) {
		if let Ok(stripped) = dll_path.strip_prefix(base_path_arg) {
			relative_out_path = stripped.to_path_buf();
		}
	} else {
		let mut is_base_dir = false;
		for component in dll_path.components() {
			if component.as_os_str() == base_dir_arg {
				is_base_dir = true;
			}
			if is_base_dir {
				relative_out_path.push(component);
			}
		}
	}

	if relative_out_path.as_os_str().is_empty() {
		if let Ok(stripped) = dll_path.strip_prefix(target_dir) {
			relative_out_path = stripped.to_path_buf();
		} else {
			relative_out_path = PathBuf::from(&*filename);
		}
	}

	let mut new_filename = relative_out_path
		.file_name()
		.unwrap_or_default()
		.to_os_string();
	new_filename.push(".txt");
	relative_out_path.set_file_name(new_filename);

	let final_out_path = Path::new(output_dir_arg).join(relative_out_path);

	if let Some(parent) = final_out_path
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
	{
		fs::create_dir_all(parent).context(format!(
			"Failed to create directories for: {}",
			parent.display()
		))?;
	}

	let mut file = OpenOptions::new()
		.create(true)
		.write(true)
		.truncate(true)
		.open(&final_out_path)
		.context(format!(
			"Failed to open output file: {}",
			final_out_path.display()
		))?;

	let hash_count = by_hash.len();

	for (hash, site) in &by_hash {
		if debug_mode {
			let method = site.method.map(|m| m.label()).unwrap_or("unknown-method");
			let name = site
				.name
				.as_deref()
				.map(|n| format!(" name=\"{n}\""))
				.unwrap_or_default();
			writeln!(
				file,
				"{} // slot 0x{:X} {} @ 0x{:X}{}",
				hash, site.slot, method, site.va, name
			)?;
		} else {
			writeln!(file, "{}", hash)?;
		}
	}

	println!(
		"[+] Found and exported {} unique hashes to {}.",
		hash_count,
		final_out_path.display()
	);

	Ok(())
}

fn module_view<'a>(pe: &PE, buffer: &'a [u8], image_base: u64) -> ModuleView<'a> {
	ModuleView {
		buffer,
		image_base,
		sections: pe
			.sections
			.iter()
			.map(|s| SectionMap {
				va: s.virtual_address as u64,
				vsize: s.virtual_size as u64,
				raw_offset: s.pointer_to_raw_data as usize,
				raw_size: s.size_of_raw_data as usize,
			})
			.collect(),
	}
}
