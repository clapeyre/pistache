# Working on Pistache

This is a hobby project. Keep documentation friendly, straightforward and light;
explain actual limitations without corporate disclaimers or forced jokes.

Pi is the chosen agent runtime. Keep its general shell/filesystem tools disabled;
the model currently gets only show_word and calculate. Bifrost is the tested
external gateway; discuss substantial architecture changes before replacing it.

Keep profiles and credentials server-side. Never add personal recordings,
transcripts, raw benchmark responses, local deployment files or backups to Git.
Use synthetic fixtures and generic context examples. Check the actual staged
files before committing, not just the ignore rules.

Run the relevant bridge and Pi tests when changing their behavior. Preserve the
tap-to-start/tap-to-finish voice flow and allow pauses. Don’t claim physical-device
validation from server tests alone.
