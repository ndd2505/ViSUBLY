import Foundation

// MARK: - API Models
struct VideoItem: Identifiable, Codable {
    let id: String
    let path: String
    let url: String
    let name: String
    let relativePath: String
    let folder: String
    let extensionType: String?
    let hasSubtitleMarker: Bool?
    let size: Int
    let modifiedAt: String?
    let subtitlePath: String?
    let subtitleName: String?
    let subtitleUrl: String?
    let hasSubtitle: Bool?
    let subtitleStatus: String?
    
    enum CodingKeys: String, CodingKey {
        case id, path, url, name, relativePath, folder
        case extensionType = "extension"
        case hasSubtitleMarker, size, modifiedAt
        case subtitlePath, subtitleName, subtitleUrl, hasSubtitle, subtitleStatus
    }
}

// Prefix extraction for grouping (e.g. SSIS-123 -> SSIS)
extension VideoItem {
    var prefixName: String? {
        let pattern = "^([A-Za-z]+)-"
        if let range = name.range(of: pattern, options: .regularExpression) {
            return String(name[range].dropLast())
        }
        return nil
    }
}

struct PairingResponse: Codable {
    let success: Bool
    let token: String?
    let message: String?
    let error: String?
}
