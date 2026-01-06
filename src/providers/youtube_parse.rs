use crate::errors::Error;

const MARKER: &str = "});ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});";
const DATA_PREFIX: &str = ", data: '";
const DATA_SUFFIX: &str = "'}";

pub fn extract_json_from_html(html: &str) -> Result<String, Error> {
    let marker_pos = html.find(MARKER).ok_or_else(|| Error::YouTube {
        stage: "extraction".to_string(),
        detail: "YTMUSIC_INITIAL_DATA marker not found in HTML".to_string(),
    })?;

    let before_marker = &html[..marker_pos];
    let js_obj_start = before_marker.rfind('{').ok_or_else(|| Error::YouTube {
        stage: "extraction".to_string(),
        detail: "Opening brace not found before marker".to_string(),
    })?;

    let js_obj = extract_balanced_json(html, js_obj_start)?;
    let decoded = decode_html_entities(&js_obj);
    let json = extract_data_field(&decoded)?;
    let unescaped = unescape_json(&json);

    Ok(unescaped)
}

fn extract_balanced_json(html: &str, start: usize) -> Result<String, Error> {
    let bytes = html.as_bytes();
    let mut i = start;
    let mut depth = 0;
    let mut in_string = false;
    let mut escape = false;

    while i < bytes.len() {
        let ch = bytes[i] as char;

        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else {
            match ch {
                '"' => in_string = true,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(html[start..=i].to_string());
                    }
                }
                _ => {}
            }
        }

        i += 1;
    }

    Err(Error::YouTube {
        stage: "extraction".to_string(),
        detail: "Unbalanced JSON object".to_string(),
    })
}

fn decode_html_entities(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if i + 3 < bytes.len() && bytes[i] == b'\\' && bytes[i + 1] == b'x' {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 2..i + 4]) {
                if let Ok(byte_val) = u8::from_str_radix(hex, 16) {
                    result.push(byte_val as char);
                    i += 4;
                    continue;
                }
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }

    result
}

fn extract_data_field(decoded: &str) -> Result<String, Error> {
    let data_start_pos = decoded.find(DATA_PREFIX).ok_or_else(|| Error::YouTube {
        stage: "extraction".to_string(),
        detail: "data field not found in JS object".to_string(),
    })?;

    let json_start = data_start_pos + DATA_PREFIX.len();
    let remaining = &decoded[json_start..];
    let json_end = remaining.rfind(DATA_SUFFIX).ok_or_else(|| Error::YouTube {
        stage: "extraction".to_string(),
        detail: "data field closing not found".to_string(),
    })?;

    Ok(remaining[..json_end].to_string())
}

fn unescape_json(json: &str) -> String {
    json.replace(r"\'", "'").replace(r"\\", "\\")
}
