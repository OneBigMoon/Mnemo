use mnemo_core::{handle_stdio_request, VERSION_BANNER};
use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let response = match args.as_slice() {
        [arg] if arg == "--version" => format!("{VERSION_BANNER}\n").into_bytes(),
        [arg] if arg == "--stdio" => handle_stdio_request(std::io::stdin().lock()),
        _ => {
            eprintln!("usage: mnemo-core --stdio | --version");
            return ExitCode::from(2);
        }
    };
    if std::io::stdout().lock().write_all(&response).is_err() {
        eprintln!("mnemo-core: failed to write response");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
