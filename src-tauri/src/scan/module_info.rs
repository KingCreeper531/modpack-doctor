//! Minimal `module-info.class` reader: just enough of the class-file format to find the
//! `Module` attribute and return the module name. Any malformed input yields None.

struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u1(&mut self) -> Option<u8> {
        let v = *self.b.get(self.pos)?;
        self.pos += 1;
        Some(v)
    }

    fn u2(&mut self) -> Option<u16> {
        let s = self.b.get(self.pos..self.pos.checked_add(2)?)?;
        self.pos += 2;
        Some(u16::from_be_bytes([s[0], s[1]]))
    }

    fn u4(&mut self) -> Option<u32> {
        let s = self.b.get(self.pos..self.pos.checked_add(4)?)?;
        self.pos += 4;
        Some(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }

    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.pos..self.pos.checked_add(n)?)?;
        self.pos += n;
        Some(s)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        self.bytes(n).map(|_| ())
    }

    /// Skip a `fields`/`methods` table.
    fn skip_members(&mut self) -> Option<()> {
        let count = self.u2()?;
        for _ in 0..count {
            self.skip(6)?; // access, name, descriptor
            let attrs = self.u2()?;
            for _ in 0..attrs {
                self.skip(2)?;
                let len = self.u4()? as usize;
                self.skip(len)?;
            }
        }
        Some(())
    }
}

#[derive(Clone)]
enum Const<'a> {
    None,
    Utf8(&'a [u8]),
    /// CONSTANT_Class or CONSTANT_Module: index of a Utf8 name.
    Named(u16),
}

/// Module name declared by a `module-info.class`, or None.
pub(crate) fn module_name(class: &[u8]) -> Option<String> {
    let mut r = Reader { b: class, pos: 0 };
    if r.u4()? != 0xCAFE_BABE {
        return None;
    }
    r.skip(4)?; // minor, major
    let count = r.u2()? as usize;
    let mut pool: Vec<Const> = vec![Const::None; count.max(1)];
    let mut i = 1;
    while i < count {
        let tag = r.u1()?;
        let mut slots = 1;
        pool[i] = match tag {
            1 => {
                let len = r.u2()? as usize;
                Const::Utf8(r.bytes(len)?)
            }
            7 | 19 => Const::Named(r.u2()?),
            8 | 16 | 20 => {
                r.skip(2)?;
                Const::None
            }
            15 => {
                r.skip(3)?;
                Const::None
            }
            3 | 4 | 9 | 10 | 11 | 12 | 17 | 18 => {
                r.skip(4)?;
                Const::None
            }
            5 | 6 => {
                r.skip(8)?;
                slots = 2;
                Const::None
            }
            _ => return None,
        };
        i += slots;
    }
    let utf8 = |idx: u16| match pool.get(idx as usize) {
        Some(Const::Utf8(b)) => Some(String::from_utf8_lossy(b).into_owned()),
        _ => None,
    };
    let named = |idx: u16| match pool.get(idx as usize) {
        Some(Const::Named(n)) => utf8(*n),
        _ => None,
    };

    r.skip(2)?; // access_flags
    let this_class = r.u2()?;
    if named(this_class).as_deref() != Some("module-info") {
        return None;
    }
    r.skip(2)?; // super_class
    let interfaces = r.u2()? as usize;
    r.skip(interfaces.checked_mul(2)?)?;
    r.skip_members()?; // fields
    r.skip_members()?; // methods
    let attrs = r.u2()?;
    for _ in 0..attrs {
        let name = r.u2()?;
        let len = r.u4()? as usize;
        let body = r.bytes(len)?;
        if utf8(name).as_deref() == Some("Module") && body.len() >= 2 {
            let module = named(u16::from_be_bytes([body[0], body[1]]))?;
            return (!module.is_empty()).then(|| module.replace('/', "."));
        }
    }
    None
}

/// A minimal valid `module-info.class` for `name` (tests only). Includes a Long constant to
/// exercise two-slot pool entries.
#[cfg(test)]
pub(crate) fn build_module_info(name: &str) -> Vec<u8> {
    fn utf8(out: &mut Vec<u8>, s: &str) {
        out.push(1);
        out.extend_from_slice(&(s.len() as u16).to_be_bytes());
        out.extend_from_slice(s.as_bytes());
    }
    let mut b = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 53];
    b.extend_from_slice(&9u16.to_be_bytes()); // pool count (8 used slots + 1)
    b.extend_from_slice(&[5, 0, 0, 0, 0, 0, 0, 0, 42]); // #1-2 Long
    utf8(&mut b, "module-info"); // #3
    b.extend_from_slice(&[7, 0, 3]); // #4 Class -> #3
    utf8(&mut b, name); // #5
    b.extend_from_slice(&[19, 0, 5]); // #6 Module -> #5
    utf8(&mut b, "Module"); // #7
    utf8(&mut b, "SourceFile"); // #8
    b.extend_from_slice(&[0x80, 0x00]); // ACC_MODULE
    b.extend_from_slice(&[0, 4, 0, 0, 0, 0, 0, 0, 0, 0]); // this, super, interfaces, fields, methods
    b.extend_from_slice(&[0, 2]); // two attributes
    b.extend_from_slice(&[0, 8, 0, 0, 0, 2, 0, 3]); // SourceFile (unrelated)
    b.extend_from_slice(&[0, 7, 0, 0, 0, 16, 0, 6]); // Module: name #6
    b.extend_from_slice(&[0; 14]); // flags, version, requires/exports/opens/uses/provides = 0
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_module_name() {
        assert_eq!(module_name(&build_module_info("com.example.mymod")).as_deref(), Some("com.example.mymod"));
    }

    #[test]
    fn malformed_inputs_are_none() {
        let good = build_module_info("a.b");
        for n in 0..good.len() {
            assert_eq!(module_name(&good[..n]), None, "truncated at {n}");
        }
        assert_eq!(module_name(b"not a class"), None);
        // A regular class is not a module.
        let mut other = good.clone();
        let pos = other.windows(11).position(|w| w == b"module-info").expect("name");
        other[pos] = b'x';
        assert_eq!(module_name(&other), None);
    }
}
