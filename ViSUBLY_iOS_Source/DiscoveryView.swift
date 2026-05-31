import SwiftUI
import Network

struct DiscoveryView: View {
    @StateObject private var networkManager = NetworkManager.shared
    @State private var isScanning = true
    @State private var showPairing = false
    @State private var showBrowser = false
    @State private var selectedServer: NWBrowser.Result?
    
    var body: some View {
        NavigationView {
            ZStack {
                Theme.bg.ignoresSafeArea()
                
                VStack(spacing: 40) {
                    // Header
                    HStack {
                        HStack(spacing: 4) {
                            Text("Vi")
                                .font(.system(size: 16, weight: .black))
                                .foregroundColor(Theme.paper)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Theme.viRed)
                                .neoStyle()
                                .rotationEffect(.degrees(-4))
                                .overlay(
                                    Image(systemName: "star.fill")
                                        .foregroundColor(Theme.viStar)
                                        .font(.system(size: 8))
                                        .offset(x: 12, y: -10)
                                )
                            Text("subly")
                                .font(.system(size: 18, weight: .black))
                                .foregroundColor(Theme.ink)
                        }
                        Spacer()
                    }
                    .padding()
                    
                    Spacer()
                    
                    // Radar Animation
                    ZStack {
                        Circle()
                            .stroke(Theme.ink.opacity(0.1), lineWidth: 2)
                            .frame(width: 200, height: 200)
                        
                        Circle()
                            .stroke(Theme.ink.opacity(0.3), lineWidth: 2)
                            .frame(width: 100, height: 100)
                            .scaleEffect(isScanning ? 2.5 : 1)
                            .opacity(isScanning ? 0 : 1)
                            .animation(Animation.easeOut(duration: 2).repeatForever(autoreverses: false), value: isScanning)
                        
                        Image(systemName: "antenna.radiowaves.left.and.right")
                            .font(.system(size: 40))
                            .foregroundColor(Theme.coral)
                    }
                    
                    Text("Đang tìm máy tính...")
                        .font(.headline)
                        .foregroundColor(Theme.ink)
                    
                    // Server List
                    ScrollView {
                        VStack(spacing: 16) {
                            ForEach(networkManager.discoveredServers, id: \.hashValue) { server in
                                ServerCard(server: server) {
                                    handleServerSelection(server)
                                }
                            }
                        }
                        .padding()
                    }
                    
                    Spacer()
                }
            }
            .navigationBarHidden(true)
            .onAppear {
                networkManager.startDiscovery()
            }
            .fullScreenCover(isPresented: $showPairing) {
                PairingView(isPresented: $showPairing, onPaired: {
                    showPairing = false
                    showBrowser = true
                })
            }
            .fullScreenCover(isPresented: $showBrowser) {
                BrowserView()
            }
        }
    }
    
    private func handleServerSelection(_ server: NWBrowser.Result) {
        selectedServer = server
        networkManager.resolveAndPair(result: server) { isPaired in
            if isPaired {
                showBrowser = true
            } else {
                showPairing = true
            }
        }
    }
}

struct ServerCard: View {
    let server: NWBrowser.Result
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            HStack {
                Image(systemName: "desktopcomputer")
                    .font(.title2)
                    .foregroundColor(Theme.ink)
                    .padding(.trailing, 8)
                
                VStack(alignment: .leading, spacing: 4) {
                    Text(serverName)
                        .font(.headline)
                        .foregroundColor(Theme.ink)
                    Text("Tap để kết nối")
                        .font(.caption)
                        .foregroundColor(Theme.inkSoft)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundColor(Theme.inkSoft)
            }
            .padding(20)
            .neoStyle()
        }
    }
    
    private var serverName: String {
        if case let .bonjour(name, _, _, _) = server.endpoint {
            return name
        }
        return "Unknown Server"
    }
}
