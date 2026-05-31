import SwiftUI
import AVKit

struct PlayerView: View {
    let video: VideoItem
    @Environment(\.presentationMode) var presentationMode
    
    @State private var player: AVPlayer?
    
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            
            if let player = player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
                    .onAppear {
                        player.play()
                    }
                    .onDisappear {
                        player.pause()
                    }
            } else {
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
            }
            
            VStack {
                HStack {
                    Button(action: {
                        presentationMode.wrappedValue.dismiss()
                    }) {
                        Image(systemName: "chevron.down.circle.fill")
                            .font(.largeTitle)
                            .foregroundColor(.white)
                            .shadow(radius: 5)
                            .padding()
                    }
                    Spacer()
                }
                Spacer()
            }
        }
        .onAppear {
            setupPlayer()
        }
    }
    
    private func setupPlayer() {
        guard let baseUrl = NetworkManager.shared.currentServerURL,
              let token = NetworkManager.shared.currentToken else { return }
        
        let ext = video.extensionType?.lowercased() ?? ""
        var streamUrlString = ""
        
        // Native MP4 supported formats
        if ["mp4", "mov", "m4v"].contains(ext) {
            let encodedId = video.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? video.id
            streamUrlString = "\\(baseUrl)/api/video/\\(encodedId)?token=\\(token)"
        } else {
            // HLS transcoded formats (mkv, avi, etc)
            let encodedId = video.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? video.id
            let encodedToken = token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? token
            streamUrlString = "\\(baseUrl)/api/hls/\\(encodedToken)/\\(encodedId)/playlist.m3u8"
        }
        
        if let url = URL(string: streamUrlString) {
            player = AVPlayer(url: url)
            
            // Allow AirPlay for the player
            player?.allowsExternalPlayback = true
            player?.usesExternalPlaybackWhileExternalScreenIsActive = true
        }
    }
}
