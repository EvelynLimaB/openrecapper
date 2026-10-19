# Recovering a saved session transcription

The CLI below re-transcribes existing per-user PCM files without starting a Discord bot or changing the source audio. It uses the same batch transcription parameters as the normal workflow, divides tracks into 5-minute core blocks, adds a small overlap for boundary context, checkpoints each completed block, and recursively subdivides blocks that return HTTP 504.

## Recovery map

Create a JSON file with the session-start timestamp and an entry for every `.pcm` file in the target session directory:

```json
{
  "sessionStartedAt": 1792365424101,
  "tracks": {
    "DISCORD_USER_ID_1": {
      "speakerName": "Speaker name",
      "offsetSeconds": 1.9
    },
    "DISCORD_USER_ID_2": {
      "speakerName": "Another speaker",
      "offsetSeconds": 30.7
    }
  }
}
```

`offsetSeconds` is the elapsed time between the recording's session start and the first PCM frame for that participant. Use the `[VoiceWorker] First audio from user ... at offset ...ms` logs if the metadata from a failed session is unavailable.

## Run from the built image

Mount the session folder and the JSON map, then run:

```powershell
podman run --rm --env-file .env `
  -v "${PWD}\recordings:/app/recordings" `
  -v "${PWD}\data:/app/data" `
  -v "${PWD}\recovery-map.json:/app/recovery-map.json:ro" `
  --entrypoint node localhost/openrecapper:chunked-transcription `
  /app/dist/retranscribe-session.js `
  /app/recordings/<session-directory> /app/recovery-map.json
```

The script creates `transcript-recovered.srt`, `transcript-recovered.txt`, `transcript-recovered.json`, and a `transcription-progress` checkpoint directory inside the session folder. It never overwrites the original PCM files. Rerunning the same command reuses completed checkpoints. A failure leaves checkpoints in place and exits nonzero; do not delete the checkpoint directory when resuming.
