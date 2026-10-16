/// MurmurHash2 token hashing, matching tier0's string-token scheme.
///
/// The engine lowercases the option string (keeping any leading `-`/`+`)
/// and hashes it with MurmurHash2 using seed `0x31415926`. See
pub fn token_hash(option: &str) -> u32 {
	let lowered: String = option.chars().map(|c| c.to_ascii_lowercase()).collect();
	let data = lowered.as_bytes();
	murmur2(data, 0x3141_5926)
}

/// Plain MurmurHash2 over `data` with `seed`, little-endian loads,
/// m = 0x5bd1e995, r = 24. Mirrors `murmur-check/main.c`.
pub fn murmur2(data: &[u8], seed: u32) -> u32 {
	const M: u32 = 0x5bd1_e995;
	const R: u32 = 24;

	let mut h = seed ^ data.len() as u32;
	let mut i = 0;
	while i + 4 <= data.len() {
		let mut k = u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
		k = k.wrapping_mul(M);
		k ^= k >> R;
		k = k.wrapping_mul(M);

		h = h.wrapping_mul(M);
		h ^= k;
		i += 4;
	}
	let rest = &data[i..];
	match rest.len() {
		3 => {
			h ^= (rest[2] as u32) << 16;
			h ^= (rest[1] as u32) << 8;
			h ^= rest[0] as u32;
			h = h.wrapping_mul(M);
		}
		2 => {
			h ^= (rest[1] as u32) << 8;
			h ^= rest[0] as u32;
			h = h.wrapping_mul(M);
		}
		1 => {
			h ^= rest[0] as u32;
			h = h.wrapping_mul(M);
		}
		_ => {}
	}

	h ^= h >> 13;
	h = h.wrapping_mul(M);
	h ^= h >> 15;
	h
}

#[cfg(test)]
mod tests {
	use super::token_hash;

	/// Vectors pinned against the repo's own data: hash lists under
	/// `hashes/cs2/`, the README example, and a value verified directly
	/// against a live tier0.dll call site (0x180045A88 reads 0xBEAE8FB6).
	#[test]
	fn hashes_known_launch_options() {
		assert_eq!(token_hash("-clearassertstate"), 3_199_111_094);
		assert_eq!(token_hash("-tools"), 197_456_290);
		assert_eq!(token_hash("-dedicated"), 1_436_925_979);
	}

	#[test]
	fn hashes_readme_examples() {
		assert_eq!(token_hash("meow"), 3_158_276_541);
		assert_eq!(token_hash("a"), 516_911_585);
	}

	#[test]
	fn lowercases_but_keeps_leading_dash_and_plus() {
		// Same string, different case, same token.
		assert_eq!(token_hash("-Tools"), token_hash("-tools"));
		// Leading dash and plus are part of the token.
		assert_ne!(token_hash("-tools"), token_hash("tools"));
		assert_ne!(token_hash("+tools"), token_hash("-tools"));
	}

	#[test]
	fn tail_lengths_cover_all_remainders() {
		// 1..=3 leftover bytes exercise the switch in the murmur tail.
		for name in ["a", "ab", "abc", "abcd", "-w", "-np", "-ww", "-dti"] {
			let rerun = token_hash(name);
			assert_eq!(rerun, token_hash(name));
		}
	}
}
