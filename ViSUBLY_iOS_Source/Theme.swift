import SwiftUI

struct Theme {
    static let bg = Color(hex: "f0eee9")
    static let paper = Color(hex: "fffdfa")
    static let ink = Color(hex: "1a1620")
    static let inkSoft = Color(hex: "675f6d")
    static let coral = Color(hex: "ff8b6e")
    static let viRed = Color(hex: "c54a3b")
    static let viStar = Color(hex: "f2ca4b")
}

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3: // RGB (12-bit)
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6: // RGB (24-bit)
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8: // ARGB (32-bit)
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue:  Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}

// Neobrutalism View Modifiers
struct NeoShadowModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .border(Theme.ink, width: 2)
            .background(Theme.paper)
            .shadow(color: Theme.ink, radius: 0, x: 3, y: 3)
    }
}

extension View {
    func neoStyle() -> some View {
        self.modifier(NeoShadowModifier())
    }
}
