import SwiftUI

final class TVModel: ObservableObject {
    @Published var host = UserDefaults.standard.string(forKey: "tvHost") ?? ""
    @Published var port = UserDefaults.standard.string(forKey: "tvPort") ?? "5555"
    @Published var connected = false
    @Published var busy = false
    @Published var status = "Укажите адрес телевизора"
    @Published var device = "Android TV"
    @Published var apps: [String] = []
    @Published var error: String?
    private let worker = DispatchQueue(label: "bitora.adb.worker")
    // Access exclusively on worker.
    private var client: ADBClient?

    func connect() {
        let host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let port = UInt16(port), port > 0, !host.isEmpty, !host.contains("://") else {
            error = "Введите IP-адрес без http:// и порт от 1 до 65535."; return
        }
        guard !busy else { return }
        busy = true; connected = false; apps = []
        status = "Подключение… Разрешите отладку на экране ТВ."
        UserDefaults.standard.set(host, forKey: "tvHost"); UserDefaults.standard.set(String(port), forKey: "tvPort")
        worker.async {
            do {
                self.client?.disconnect()
                let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                let identity = try ADBIdentity(url: directory.appendingPathComponent("bitora-adb-key.der"))
                let client = ADBClient(identity: identity); self.client = client
                _ = try client.connect(host: host, port: port)
                let model = try client.shell("getprop ro.product.model").trimmingCharacters(in: .whitespacesAndNewlines)
                DispatchQueue.main.async { self.busy = false; self.connected = true; self.device = model.isEmpty ? "Android TV" : model; self.status = "Подключено к \(host)" }
            } catch { self.fail(error) }
        }
    }
    private func fail(_ error: Error) {
        DispatchQueue.main.async { self.busy = false; self.connected = false; self.status = "Соединение закрыто"; self.error = error.localizedDescription }
    }
    func disconnect() {
        guard !busy else { return }
        connected = false; apps = []; status = "Отключено"
        worker.async { self.client?.disconnect(); self.client = nil }
    }
    func run(_ command: String, completion: @escaping (String) -> Void = { _ in }) {
        guard connected, !busy else { return }
        busy = true
        worker.async {
            do {
                guard let client = self.client else { throw TVError("Нет подключения.") }
                let result = try client.shell(command)
                DispatchQueue.main.async { self.busy = false; completion(result) }
            } catch { self.fail(error) }
        }
    }
    func key(_ code: Int) { run("input keyevent \(code)") }
    func loadApps() {
        run("pm list packages") { output in
            self.apps = output.components(separatedBy: .newlines).filter { $0.hasPrefix("package:") }
                .map { String($0.dropFirst(8)).trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter(Self.validPackage).sorted()
        }
    }
    static func validPackage(_ name: String) -> Bool {
        name.range(of: "^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$", options: .regularExpression) != nil
    }
    func launch(_ name: String) {
        guard Self.validPackage(name) else { return }
        run("monkey -p '\(name)' -c android.intent.category.LAUNCHER 1") { output in
            if output.contains("No activities") || output.contains("aborted") || output.contains("Error") {
                self.error = "У пакета нет доступного экрана запуска.\n" + String(output.prefix(500))
            }
        }
    }
}

@main struct BitoraApp: App {
    var body: some Scene { WindowGroup { ContentView().preferredColorScheme(.dark) } }
}

struct ContentView: View {
    @StateObject private var tv = TVModel()
    @State private var search = ""
    @State private var text = ""
    private let lime = Color(red: 0.83, green: 0.98, blue: 0.16)
    var body: some View {
        TabView {
            NavigationStack {
                ScrollView {
                    VStack(spacing: 22) {
                        HStack(spacing: 16) {
                            Image("Brand").resizable().scaledToFit().frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 15))
                            VStack(alignment: .leading) { Text("Bitora").font(.largeTitle.bold()); Text("Android TV").foregroundStyle(.secondary) }
                            Spacer()
                        }
                        GroupBox {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(tv.connected ? tv.device : "Подключение к телевизору").font(.headline)
                                HStack {
                                    TextField("IP, например 192.168.1.20", text: $tv.host).keyboardType(.decimalPad)
                                    TextField("Порт", text: $tv.port).keyboardType(.numberPad).frame(width: 65)
                                }.textFieldStyle(.roundedBorder).disabled(tv.busy || tv.connected)
                                Button(tv.connected ? "Отключиться" : "Подключиться") { tv.connected ? tv.disconnect() : tv.connect() }
                                    .buttonStyle(.borderedProminent).disabled(tv.busy)
                                HStack { if tv.busy { ProgressView() }; Text(tv.status).font(.caption).foregroundStyle(.secondary) }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                        VStack(spacing: 12) {
                            key("chevron.up", "Вверх", 19)
                            HStack(spacing: 24) { key("chevron.left", "Влево", 21); key("circle.inset.filled", "OK", 23); key("chevron.right", "Вправо", 22) }
                            key("chevron.down", "Вниз", 20)
                            HStack { key("arrow.uturn.backward", "Назад", 4); key("house", "Домой", 3); key("line.3.horizontal", "Меню", 82) }
                            HStack { key("speaker.minus", "Тише", 25); key("playpause", "Пауза", 85); key("speaker.plus", "Громче", 24) }
                        }.disabled(!tv.connected || tv.busy)
                        GroupBox("Ввод текста") {
                            VStack(alignment: .leading) {
                                TextField("Текст латиницей", text: $text).textFieldStyle(.roundedBorder)
                                Text("Сначала выберите поле на ТВ. Кириллица через ADB input не поддерживается.").font(.caption).foregroundStyle(.secondary)
                                Button("Отправить") {
                                    let escaped = text.replacingOccurrences(of: "'", with: "'\\''").replacingOccurrences(of: " ", with: "%s")
                                    tv.run("input text '\(escaped)'")
                                }.disabled(!tv.connected || tv.busy || text.isEmpty || !text.unicodeScalars.allSatisfy { $0.value >= 32 && $0.value <= 126 } || text.count > 300)
                            }
                        }
                        Button { tv.run("am start -a android.settings.SETTINGS") } label: { Label("Открыть настройки ТВ", systemImage: "gearshape") }
                            .disabled(!tv.connected || tv.busy)
                    }.padding()
                }.navigationTitle("Пульт").navigationBarTitleDisplayMode(.inline)
            }.tabItem { Label("Пульт", systemImage: "appletvremote.gen1") }
            NavigationStack {
                List {
                    if !tv.connected { Text("Сначала подключитесь к телевизору на вкладке «Пульт».") }
                    else if tv.apps.isEmpty { Text("Нажмите «Обновить», чтобы получить список пакетов с ТВ.") }
                    ForEach(tv.apps.filter { search.isEmpty || $0.localizedCaseInsensitiveContains(search) }, id: \.self) { name in
                        Button { tv.launch(name) } label: { Label(name, systemImage: "play.rectangle").font(.subheadline) }
                            .disabled(tv.busy)
                    }
                }.searchable(text: $search, prompt: "Название пакета")
                    .navigationTitle("Приложения")
                    .toolbar { Button("Обновить") { tv.loadApps() }.disabled(!tv.connected || tv.busy) }
                    .overlay { if tv.busy { ProgressView() } }
            }.tabItem { Label("Приложения", systemImage: "square.grid.2x2") }
            NavigationStack {
                List {
                    Section("Как подключить") {
                        Text("1. Подключите iPhone и Android TV к одной сети Wi-Fi.")
                        Text("2. Включите на ТВ режим разработчика и сетевую отладку ADB. Обычно используется порт 5555.")
                        Text("3. Введите IP телевизора, разрешите Bitora доступ к локальной сети и нажмите «Подключиться».")
                        Text("4. На ТВ подтвердите запрос «Разрешить отладку» для этого iPhone. Можно выбрать «Всегда разрешать».")
                    }
                    Section("Возможности версии 0.1") {
                        Text("Пульт, громкость, воспроизведение, запуск установленных приложений, ввод латиницей и открытие настроек ТВ. Компьютер для подключения не нужен.")
                        Text("Сопряжение по коду (Wireless debugging/TLS), установка APK, очистка системных пакетов и редактор лаунчера пока не перенесены. Если ТВ поддерживает только сопряжение по коду, эта версия к нему не подключится.")
                    }
                    Section("Конфиденциальность") { Text("Соединение идёт напрямую с указанным телевизором. Ключ ADB хранится на устройстве. Аналитики, рекламы и внешнего сервера нет.") }
                    Section("О программе") {
                        Text("Bitora Android TV для iOS · 0.1.0")
                        Text("На основе проекта CleanMyTV, wingedpanther. Лицензия MIT.")
                        Link("Исходники и поддержка", destination: URL(string: "https://github.com/userArturM/cleanmytvrus")!)
                    }
                }.navigationTitle("Помощь")
            }.tabItem { Label("Помощь", systemImage: "questionmark.circle") }
        }.tint(lime)
            .alert("Bitora Android TV", isPresented: Binding(get: { tv.error != nil }, set: { if !$0 { tv.error = nil } })) {
                Button("Понятно") { tv.error = nil }
            } message: { Text(tv.error ?? "") }
    }
    private func key(_ symbol: String, _ title: String, _ code: Int) -> some View {
        Button { tv.key(code) } label: {
            Image(systemName: symbol).font(.title2).frame(width: 66, height: 52)
        }.buttonStyle(.bordered).accessibilityLabel(title)
    }
}
