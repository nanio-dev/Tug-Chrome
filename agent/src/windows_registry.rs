//! Small read-only registry probes; avoid spawning reg.exe for every browser on startup.
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_SZ, RegCloseKey,
    RegGetValueW, RegOpenKeyExW,
};
fn key_parts(key: &str) -> Option<(HKEY, Vec<u16>)> {
    let (hive, path) = key.split_once('\\')?;
    let root = match hive {
        "HKCU" => HKEY_CURRENT_USER,
        "HKLM" => HKEY_LOCAL_MACHINE,
        _ => return None,
    };
    Some((root, path.encode_utf16().chain(Some(0)).collect()))
}
pub fn exists(key: &str) -> bool {
    let Some((root, path)) = key_parts(key) else {
        return false;
    };
    let mut handle = std::ptr::null_mut();
    // All pointers are valid, terminated UTF-16; the returned handle is closed here.
    unsafe {
        if RegOpenKeyExW(root, path.as_ptr(), 0, KEY_READ, &mut handle) != 0 {
            return false;
        }
        RegCloseKey(handle);
    }
    true
}
pub fn string(key: &str, name: &str) -> Option<String> {
    let (root, path) = key_parts(key)?;
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut size = 0u32;
    unsafe {
        if RegGetValueW(
            root,
            path.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        ) != 0
        {
            return None;
        }
        if size > 1024 * 1024 {
            return None;
        }
        let mut data = vec![0u16; (size as usize).div_ceil(2)];
        if RegGetValueW(
            root,
            path.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            data.as_mut_ptr().cast(),
            &mut size,
        ) != 0
        {
            return None;
        }
        data.truncate(size as usize / 2);
        while data.last() == Some(&0) {
            data.pop();
        }
        String::from_utf16(&data).ok()
    }
}
