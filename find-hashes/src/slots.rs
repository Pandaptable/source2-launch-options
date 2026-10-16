/// CCommandLine vtable token-slot classification.
///
/// The token methods of tier0's `CCommandLine` sit at fixed vtable slots.
/// The token (a u32 MurmurHash2 of the lowercased option name) is always
/// passed in EDX as the second argument. Slots 0x88-0xB8 are the same
/// seven methods reached once the launcher lock is held.
///
/// | Slot  | Method                    |
/// |-------|---------------------------|
/// | 0x18  | CheckParm                 |
/// | 0x20  | HasParm                   |
/// | 0x30  | FindParm                  |
/// | 0x40  | ParmValue(CBufferString)  |
/// | 0x48  | ParmValue(float)          |
/// | 0x50  | ParmValue(int)            |
/// | 0x58  | ParmValue(const char*)    |
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TokenMethod {
	/// CheckParm: returns the raw parm string, or null.
	CheckParm,
	/// HasParm: boolean presence check.
	HasParm,
	/// FindParm: returns the 1-based command-line index, 0 if absent.
	FindParm,
	/// ParmValue writing into a caller-provided CBufferString.
	ParmValueBuffer,
	/// ParmValue with a float default.
	ParmValueFloat,
	/// ParmValue with an int default.
	ParmValueInt,
	/// ParmValue with a const char* default.
	ParmValueCStr,
}

impl TokenMethod {
	/// Short label used in debug output.
	pub fn label(self) -> &'static str {
		match self {
			TokenMethod::CheckParm => "check",
			TokenMethod::HasParm => "flag",
			TokenMethod::FindParm => "index",
			TokenMethod::ParmValueBuffer => "string",
			TokenMethod::ParmValueFloat => "float",
			TokenMethod::ParmValueInt => "int",
			TokenMethod::ParmValueCStr => "cstr",
		}
	}
}

/// Maps a vtable displacement to the token method at that slot,
/// or `None` when the slot is not one of the seven token methods
/// (e.g. 0x08, which tier0's own CreateCommandLine uses).
pub fn token_method(slot: u64) -> Option<TokenMethod> {
	const PRIMARY: [(u64, TokenMethod); 7] = [
		(0x18, TokenMethod::CheckParm),
		(0x20, TokenMethod::HasParm),
		(0x30, TokenMethod::FindParm),
		(0x40, TokenMethod::ParmValueBuffer),
		(0x48, TokenMethod::ParmValueFloat),
		(0x50, TokenMethod::ParmValueInt),
		(0x58, TokenMethod::ParmValueCStr),
	];
	// The post-lock variants are laid out uniformly (stride 8 from 0x88),
	// unlike the primary set which has gaps; match positionally.
	const POST_LOCK: [(u64, TokenMethod); 7] = [
		(0x88, TokenMethod::CheckParm),
		(0x90, TokenMethod::HasParm),
		(0x98, TokenMethod::FindParm),
		(0xA0, TokenMethod::ParmValueBuffer),
		(0xA8, TokenMethod::ParmValueFloat),
		(0xB0, TokenMethod::ParmValueInt),
		(0xB8, TokenMethod::ParmValueCStr),
	];

	[PRIMARY, POST_LOCK]
		.into_iter()
		.flatten()
		.find(|(s, _)| *s == slot)
		.map(|(_, method)| method)
}

#[cfg(test)]
mod tests {
	use super::{TokenMethod, token_method};

	#[test]
	fn primary_slots_match_the_doc_table() {
		assert_eq!(token_method(0x18), Some(TokenMethod::CheckParm));
		assert_eq!(token_method(0x20), Some(TokenMethod::HasParm));
		assert_eq!(token_method(0x30), Some(TokenMethod::FindParm));
		assert_eq!(token_method(0x40), Some(TokenMethod::ParmValueBuffer));
		assert_eq!(token_method(0x48), Some(TokenMethod::ParmValueFloat));
		assert_eq!(token_method(0x50), Some(TokenMethod::ParmValueInt));
		assert_eq!(token_method(0x58), Some(TokenMethod::ParmValueCStr));
	}

	#[test]
	fn post_lock_slots_mirror_the_primary_set() {
		assert_eq!(token_method(0x88), Some(TokenMethod::CheckParm));
		assert_eq!(token_method(0x90), Some(TokenMethod::HasParm));
		assert_eq!(token_method(0x98), Some(TokenMethod::FindParm));
		assert_eq!(token_method(0xA0), Some(TokenMethod::ParmValueBuffer));
		assert_eq!(token_method(0xA8), Some(TokenMethod::ParmValueFloat));
		assert_eq!(token_method(0xB0), Some(TokenMethod::ParmValueInt));
		assert_eq!(token_method(0xB8), Some(TokenMethod::ParmValueCStr));
	}

	#[test]
	fn non_token_slots_are_rejected() {
		for slot in [
			0x00, 0x08, 0x10, 0x28, 0x38, 0x60, 0x68, 0x70, 0x78, 0x80, 0xC0,
		] {
			assert_eq!(
				token_method(slot),
				None,
				"slot 0x{slot:X} should not classify"
			);
		}
	}

	#[test]
	fn odd_and_huge_displacements_are_rejected() {
		for slot in [1, 3, 0x19, 0x21, 0x100, 0x1000, u64::from(u32::MAX)] {
			assert_eq!(
				token_method(slot),
				None,
				"slot 0x{slot:X} should not classify"
			);
		}
	}
}
