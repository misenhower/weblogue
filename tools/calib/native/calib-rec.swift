/*
 * CoreAudio-native capture helper for the calibration rig. Replaces ffmpeg's
 * avfoundation input, which silently drops packets (measured up to ~7 small
 * chunk-losses/sec on a quartz-stable source; AVAudioEngine on the same
 * device+cable captured 0 in the same conditions — 2026-07-10 diagnosis).
 *
 *   calib-rec list                                     input devices as "<halID>\t<name>"
 *   calib-rec rec <halID> <seconds> <rate> <ch> <out.wav>
 *   calib-rec stream <halID> <rate>                    mono f32le to stdout until SIGINT
 *
 * Rate/channel conversion happens here (AVAudioConverter — CoreAudio's SRC),
 * so callers keep ffmpeg-era semantics: ask for 48 kHz, get 48 kHz.
 */
import AVFoundation
import CoreAudio

func allDeviceIDs() -> [AudioDeviceID] {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
  return ids
}

func deviceName(_ id: AudioDeviceID) -> String {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceNameCFString,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var name: CFString = "" as CFString
  var size = UInt32(MemoryLayout<CFString>.size)
  withUnsafeMutablePointer(to: &name) { ptr in
    _ = AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr)
  }
  return name as String
}

func hasInput(_ id: AudioDeviceID) -> Bool {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreamConfiguration,
    mScope: kAudioDevicePropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return false }
  let buf = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 8)
  defer { buf.deallocate() }
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, buf) == noErr else { return false }
  return buf.assumingMemoryBound(to: AudioBufferList.self).pointee.mNumberBuffers > 0
}

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

/** Engine + converter wired to a HAL device; onBuffer receives converted audio. */
func startCapture(
  deviceID: AudioDeviceID,
  rate: Double,
  channels: AVAudioChannelCount,
  onBuffer: @escaping (AVAudioPCMBuffer) -> Void
) -> AVAudioEngine {
  let engine = AVAudioEngine()
  var dev = deviceID
  let au = engine.inputNode.audioUnit!
  guard AudioUnitSetProperty(
    au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
    &dev, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else {
    fail("cannot select device \(deviceID)")
  }
  // hardware-side format: a tap with a mismatched format silently never fires
  let hw = engine.inputNode.inputFormat(forBus: 0)
  guard hw.sampleRate > 0 else { fail("device \(deviceID) reports no input format") }
  let out = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: channels, interleaved: false)!
  let conv = AVAudioConverter(from: hw, to: out)!
  engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: hw) { buffer, _ in
    let cap = AVAudioFrameCount((Double(buffer.frameLength) * rate / hw.sampleRate).rounded(.up)) + 64
    guard let converted = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap) else { return }
    var fed = false
    conv.convert(to: converted, error: nil) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    if converted.frameLength > 0 { onBuffer(converted) }
  }
  do {
    try engine.start()
  } catch {
    fail("engine start failed: \(error)")
  }
  return engine
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "list":
  for id in allDeviceIDs() where hasInput(id) {
    print("\(id)\t\(deviceName(id))")
  }

case "rec":
  guard args.count == 7,
    let devID = UInt32(args[2]), let seconds = Double(args[3]),
    let rate = Double(args[4]), let ch = UInt32(args[5])
  else { fail("usage: calib-rec rec <halID> <seconds> <rate> <channels> <out.wav>") }
  let outFormat: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: rate,
    AVNumberOfChannelsKey: ch,
    AVLinearPCMBitDepthKey: 32,
    AVLinearPCMIsFloatKey: true,
    AVLinearPCMIsNonInterleaved: false,
  ]
  var file: AVAudioFile? = try? AVAudioFile(
    forWriting: URL(fileURLWithPath: args[6]), settings: outFormat,
    commonFormat: .pcmFormatFloat32, interleaved: false)
  guard file != nil else { fail("cannot open output \(args[6])") }
  var announced = false
  let engine = startCapture(deviceID: devID, rate: rate, channels: AVAudioChannelCount(ch)) { buf in
    if !announced {
      announced = true
      FileHandle.standardError.write("READY\n".data(using: .utf8)!)
    }
    try? file?.write(from: buf)
  }
  RunLoop.main.run(until: Date(timeIntervalSinceNow: seconds))
  engine.stop()
  engine.inputNode.removeTap(onBus: 0)
  file = nil // finalize the WAV header

case "stream":
  guard args.count == 4, let devID = UInt32(args[2]), let rate = Double(args[3]) else {
    fail("usage: calib-rec stream <halID> <rate>")
  }
  signal(SIGINT) { _ in exit(0) }
  signal(SIGTERM) { _ in exit(0) }
  let stdout = FileHandle.standardOutput
  _ = startCapture(deviceID: devID, rate: rate, channels: 1) { buf in
    guard let data = buf.floatChannelData else { return }
    stdout.write(Data(bytes: data[0], count: Int(buf.frameLength) * 4))
  }
  RunLoop.main.run()

default:
  fail("usage: calib-rec <list | rec <halID> <secs> <rate> <ch> <out.wav> | stream <halID> <rate>>")
}
