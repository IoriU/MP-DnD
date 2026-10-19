// Imported first by the training scripts, before the game: fights at full speed, no save files, and nothing on stdout
// but the trainer's protocol (anything the game logs goes to stderr).
process.env.DELVERS_SPEED = '1000000';
process.env.DELVERS_SAVES = 'off';
console.log = (...args: unknown[]) => console.error(...args);
