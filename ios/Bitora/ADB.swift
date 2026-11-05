import Foundation
import Network
import Security

struct TVError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

extension Data {
    mutating func word(_ value: UInt32) {
        append(contentsOf: (0..<4).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) })
    }
    func word(at i: Int) -> UInt32 {
        (0..<4).reduce(0) { $0 | UInt32(self[startIndex + i + $1]) << ($1 * 8) }
    }
}

// ADB uses a SHA-1-sized random challenge, not a message to hash again.
final class ADBIdentity {
    let key: SecKey
    init(url: URL) throws {
        let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
                                        kSecAttrKeySizeInBits as String: 2048,
                                        kSecAttrKeyClass as String: kSecAttrKeyClassPrivate]
        var error: Unmanaged<CFError>?
        if FileManager.default.fileExists(atPath: url.path) {
            guard let key = SecKeyCreateWithData(try Data(contentsOf: url) as CFData, attributes as CFDictionary, &error) else {
                throw TVError("Не удалось прочитать ключ ADB.")
            }
            self.key = key
        } else {
            guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error),
                  let bytes = SecKeyCopyExternalRepresentation(key, &error) else { throw TVError("Не удалось создать ключ ADB.") }
            self.key = key
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try (bytes as Data).write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        }
    }
    func sign(_ token: Data) throws -> Data {
        guard token.count == 20 else { throw TVError("Некорректный запрос авторизации ADB.") }
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .rsaSignatureDigestPKCS1v15SHA1, token as CFData, &error) else {
            throw TVError("Не удалось подписать запрос ADB.")
        }
        return signature as Data
    }
    func publicKey() throws -> Data {
        guard let pub = SecKeyCopyPublicKey(key), let der = SecKeyCopyExternalRepresentation(pub, nil) else {
            throw TVError("Публичный ключ недоступен.")
        }
        let bytes = [UInt8](der as Data)
        var offset = 0
        func field(_ tag: UInt8) throws -> [UInt8] {
            guard offset + 2 <= bytes.count, bytes[offset] == tag else { throw TVError("Некорректный RSA DER.") }
            offset += 1
            var count = Int(bytes[offset]); offset += 1
            if count > 127 {
                let n = count & 127; count = 0
                guard n > 0, n <= 4, offset + n <= bytes.count else { throw TVError("Некорректная длина DER.") }
                for _ in 0..<n { count = count * 256 + Int(bytes[offset]); offset += 1 }
            }
            guard count <= bytes.count - offset else { throw TVError("Усечённый ключ DER.") }
            if tag == 0x30 { return [] }
            let result = Array(bytes[offset..<offset + count]); offset += count
            return result
        }
        _ = try field(0x30)
        var modulus = try field(2)
        while modulus.first == 0 { modulus.removeFirst() }
        let exponent = try field(2).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard modulus.count == 256, exponent == 65537 else { throw TVError("Нужен ключ RSA-2048.") }
        let n = Array(modulus.reversed()) + [UInt8(0)]
        let n0 = Data(n).word(at: 0)
        var inverse: UInt32 = 1
        for _ in 0..<5 { inverse = inverse &* (2 &- n0 &* inverse) }
        // R² mod n, computed without a third-party big-number dependency.
        var rr = [UInt8](repeating: 0, count: 257); rr[0] = 1
        for _ in 0..<4096 {
            var carry = 0
            for i in 0..<257 { let v = Int(rr[i]) * 2 + carry; rr[i] = UInt8(v & 255); carry = v >> 8 }
            var greater = true
            for i in (0..<257).reversed() where rr[i] != n[i] { greater = rr[i] > n[i]; break }
            if greater {
                var borrow = 0
                for i in 0..<257 { let v = Int(rr[i]) - Int(n[i]) - borrow; rr[i] = UInt8(v & 255); borrow = v < 0 ? 1 : 0 }
            }
        }
        var result = Data(); result.word(64); result.word(0 &- inverse)
        result.append(contentsOf: n.prefix(256)); result.append(contentsOf: rr.prefix(256)); result.word(exponent)
        return Data((result.base64EncodedString() + " bitora@ios\0").utf8)
    }
}

struct ADBPacket {
    let command: UInt32
    let a: UInt32
    let b: UInt32
    let data: Data
    func encoded() -> Data {
        var result = Data()
        for word in [command, a, b, UInt32(data.count), data.reduce(UInt32(0)) { $0 &+ UInt32($1) }, ~command] { result.word(word) }
        result.append(data); return result
    }
}

// All blocking methods run on the model's serial worker, never on the UI/network queue.
final class ADBClient {
    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "bitora.network")
    private var nextID: UInt32 = 0
    let identity: ADBIdentity
    init(identity: ADBIdentity) { self.identity = identity }
    func disconnect() { connection?.cancel(); connection = nil }
    deinit { disconnect() }

    func connect(host: String, port: UInt16) throws -> String {
        disconnect()
        guard !host.isEmpty, port > 0 else { throw TVError("Укажите IP-адрес и порт ТВ.") }
        let c = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        connection = c
        let ready = DispatchSemaphore(value: 0)
        var connectError: Error?
        c.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case .failed(let error): connectError = error; ready.signal()
            default: break
            }
        }
        c.start(queue: queue)
        guard ready.wait(timeout: .now() + 12) == .success else { disconnect(); throw TVError("ТВ не отвечает. Проверьте IP, Wi-Fi и доступ к локальной сети в настройках iOS.") }
        c.stateUpdateHandler = nil
        if let error = connectError { disconnect(); throw error }
        do {
            try send(0x4e584e43, 0x01000000, 4096, Data("host::\0".utf8))
            var authCount = 0
            for _ in 0..<8 {
                let p = try receive(timeout: 60)
                if p.command == 0x4e584e43 { return String(decoding: p.data, as: UTF8.self) }
                if p.command == 0x534c5453 { throw TVError("Этот порт требует сопряжения по коду. В версии 0.1 поддерживается только обычная сетевая отладка ADB (обычно порт 5555).") }
                guard p.command == 0x48545541, p.a == 1, p.data.count == 20 else { throw TVError("Неожиданный ответ ADB.") }
                authCount += 1
                if authCount == 1 { try send(0x48545541, 2, 0, identity.sign(p.data)) }
                else if authCount == 2 { try send(0x48545541, 3, 0, identity.publicKey()) }
                else { throw TVError("Авторизация отклонена. Разрешите отладку на телевизоре.") }
            }
            throw TVError("Не удалось авторизоваться.")
        } catch { disconnect(); throw error }
    }
    private func send(_ command: UInt32, _ a: UInt32, _ b: UInt32, _ data: Data = Data()) throws {
        guard let c = connection else { throw TVError("Подключитесь к телевизору.") }
        let done = DispatchSemaphore(value: 0); var failure: Error?
        c.send(content: ADBPacket(command: command, a: a, b: b, data: data).encoded(), completion: .contentProcessed { failure = $0; done.signal() })
        guard done.wait(timeout: .now() + 10) == .success else { disconnect(); throw TVError("Тайм-аут отправки.") }
        if let failure = failure { throw failure }
    }
    private func read(_ count: Int, timeout: Double) throws -> Data {
        guard let c = connection else { throw TVError("Нет соединения.") }
        var output = Data()
        let deadline = Date().addingTimeInterval(timeout)
        while output.count < count {
            let done = DispatchSemaphore(value: 0); var chunk: Data?; var failure: Error?; var ended = false
            c.receive(minimumIncompleteLength: 1, maximumLength: count - output.count) { data, _, complete, error in
                chunk = data; failure = error; ended = complete; done.signal()
            }
            guard done.wait(timeout: .now() + max(0, deadline.timeIntervalSinceNow)) == .success else {
                disconnect(); throw TVError("Время ожидания истекло. Подтвердите запрос на ТВ и подключитесь снова.")
            }
            if let failure = failure { throw failure }
            if let chunk = chunk { output.append(chunk) }
            if output.count < count && (ended || chunk?.isEmpty != false) { throw TVError("ТВ закрыл соединение.") }
        }
        return output
    }
    private func receive(timeout: Double = 15) throws -> ADBPacket {
        let h = try read(24, timeout: timeout)
        let size = Int(h.word(at: 12))
        guard h.word(at: 20) == ~h.word(at: 0), size <= 4096 else { throw TVError("Некорректный пакет ADB.") }
        let data = try read(size, timeout: timeout)
        guard data.reduce(UInt32(0), { $0 &+ UInt32($1) }) == h.word(at: 16) else { throw TVError("Ошибка контрольной суммы ADB.") }
        return ADBPacket(command: h.word(at: 0), a: h.word(at: 4), b: h.word(at: 8), data: data)
    }
    func shell(_ command: String) throws -> String {
        do {
            nextID &+= 1; let local = nextID
            let payload = Data(("shell:" + command + "\0").utf8)
            guard payload.count < 4096 else { throw TVError("Слишком длинная команда.") }
            try send(0x4e45504f, local, 0, payload)
            var remote: UInt32 = 0; var result = Data()
            let deadline = Date().addingTimeInterval(30)
            while Date() < deadline {
                let p = try receive()
                guard p.b == local else { throw TVError("Несовпадение потока ADB.") }
                switch p.command {
                case 0x59414b4f: remote = p.a
                case 0x45545257:
                    guard remote != 0, p.a == remote, result.count + p.data.count <= 2 * 1024 * 1024 else { throw TVError("Некорректный поток ADB.") }
                    result.append(p.data); try send(0x59414b4f, local, remote)
                case 0x45534c43:
                    try send(0x45534c43, local, p.a)
                    guard remote != 0 else { throw TVError("ТВ отказал в запуске команды.") }
                    return String(decoding: result, as: UTF8.self)
                default: throw TVError("Неожиданный пакет ADB.")
                }
            }
            throw TVError("Команда выполняется слишком долго.")
        } catch { disconnect(); throw error }
    }
}
