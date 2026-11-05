import Foundation
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
do {
    let identity = try ADBIdentity(url: folder.appendingPathComponent("key.der"))
    if CommandLine.arguments.count == 2 {
        try identity.publicKey().write(to: folder.appendingPathComponent("public.txt"))
        try identity.sign(Data(repeating: 0x42, count: 20)).write(to: folder.appendingPathComponent("signature.bin"))
        let reloaded = try ADBIdentity(url: folder.appendingPathComponent("key.der"))
        guard try identity.publicKey() == reloaded.publicKey() else { throw TVError("Key persistence failed") }
        do { _ = try identity.sign(Data([1])); fatalError("Accepted invalid token") } catch {}
        print("Identity tests passed")
    } else {
        let client = ADBClient(identity: identity)
        _ = try client.connect(host: "127.0.0.1", port: UInt16(CommandLine.arguments[2])!)
        let result = try client.shell("echo bitora")
        guard result == "bitora\n" else { throw TVError("Wrong shell output") }
        client.disconnect()
        print("Transport test passed")
    }
} catch { fputs("\(error)\n", stderr); exit(1) }
