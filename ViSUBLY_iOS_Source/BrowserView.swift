import SwiftUI
import AVKit

struct BrowserView: View {
    @StateObject private var networkManager = NetworkManager.shared
    @State private var videos: [VideoItem] = []
    @State private var isLoading = true
    @State private var selectedVideo: VideoItem?
    
    var groupedVideos: [String: [VideoItem]] {
        Dictionary(grouping: videos, by: { $0.folder })
    }
    
    var body: some View {
        NavigationView {
            ZStack {
                Theme.bg.ignoresSafeArea()
                
                if isLoading {
                    ProgressView("Đang tải dữ liệu...")
                        .progressViewStyle(CircularProgressViewStyle(tint: Theme.ink))
                } else if videos.isEmpty {
                    VStack {
                        Image(systemName: "folder.badge.questionmark")
                            .font(.system(size: 50))
                            .foregroundColor(Theme.inkSoft)
                            .padding()
                        Text("Thư mục trống hoặc PC chưa chọn thư mục.")
                            .font(.headline)
                            .foregroundColor(Theme.ink)
                    }
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 20) {
                            ForEach(groupedVideos.keys.sorted(), id: \.self) { folderName in
                                Section(header: Text(folderName).font(.title2).bold().padding(.top)) {
                                    ForEach(groupedVideos[folderName] ?? []) { video in
                                        VideoCard(video: video) {
                                            selectedVideo = video
                                        }
                                    }
                                }
                            }
                        }
                        .padding()
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 4) {
                        Text("Vi")
                            .font(.system(size: 14, weight: .black))
                            .foregroundColor(Theme.paper)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Theme.viRed)
                            .neoStyle()
                            .rotationEffect(.degrees(-4))
                        Text("subly")
                            .font(.system(size: 16, weight: .black))
                            .foregroundColor(Theme.ink)
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        networkManager.fetchVideos { fetched in
                            videos = fetched
                        }
                    }) {
                        Image(systemName: "arrow.clockwise")
                            .foregroundColor(Theme.ink)
                    }
                }
            }
            .onAppear {
                fetchData()
            }
            .sheet(item: $selectedVideo) { video in
                PlayerView(video: video)
            }
        }
    }
    
    private func fetchData() {
        isLoading = true
        networkManager.fetchVideos { fetched in
            videos = fetched
            isLoading = false
        }
    }
}

struct VideoCard: View {
    let video: VideoItem
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                ZStack {
                    Rectangle()
                        .fill(Theme.ink)
                        .frame(width: 80, height: 45)
                    Image(systemName: "play.fill")
                        .foregroundColor(Theme.paper)
                }
                .border(Theme.ink, width: 2)
                
                VStack(alignment: .leading, spacing: 4) {
                    Text(video.name)
                        .font(.headline)
                        .foregroundColor(Theme.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    
                    HStack {
                        Text(formatBytes(video.size))
                            .font(.caption)
                            .foregroundColor(Theme.inkSoft)
                            .fontDesign(.monospaced)
                        
                        if let ext = video.extensionType {
                            Text(ext.uppercased())
                                .font(.caption)
                                .padding(.horizontal, 4)
                                .background(Theme.coral)
                                .foregroundColor(Theme.ink)
                                .cornerRadius(4)
                        }
                    }
                }
                Spacer()
            }
            .padding(12)
            .neoStyle()
        }
    }
    
    private func formatBytes(_ bytes: Int) -> String {
        let mb = Double(bytes) / 1024 / 1024
        return String(format: "%.1f MB", mb)
    }
}
