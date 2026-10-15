// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "HistoriaCore", platforms: [.macOS(.v13), .iOS(.v17)], products: [.library(name: "HistoriaCore", targets: ["HistoriaCore"])], targets: [.target(name: "HistoriaCore", path: "Sources/Core"), .testTarget(name: "HistoriaCoreTests", dependencies: ["HistoriaCore"], path: "Tests", resources: [.copy("Fixtures")])])
