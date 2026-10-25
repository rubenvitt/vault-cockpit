import SwiftUI
import UIKit

/// Farben aus den Tokens von cockpit.css (`:root`, hell und dunkel), ohne Asset-Katalog.
enum Theme {
    static let bg = Color(uiColor: .cockpitBackground)
    static let bgSunk = Color(light: 0xEFEBE4, dark: 0x0E0D0C)
    static let surface = Color(light: 0xFFFEFB, dark: 0x1C1A18)
    static let surface2 = Color(light: 0xFAF8F4, dark: 0x22201D)
    static let text = Color(light: 0x1D1B18, dark: 0xEFEBE4)
    static let text2 = Color(light: 0x5F5A52, dark: 0xAAA398)
    static let text3 = Color(light: 0x8B857B, dark: 0x7C766C)
    static let line = Color(light: 0xE8E3DA, dark: 0x2F2C28)
    static let lineStrong = Color(light: 0xD5CEC2, dark: 0x423D37)

    static let accent = Color(uiColor: .cockpitAccent)
    static let accentSoft = Color(light: 0xFDF0E6, dark: 0x2A1C12)
    static let accentLine = Color(light: 0xF4CBAF, dark: 0x5C3519)
    static let onAccent = Color(light: 0xFFFFFF, dark: 0x1B1009)
    static let ok = Color(light: 0x15803D, dark: 0x4ADE80)
    static let okSoft = Color(light: 0xE8F5EC, dark: 0x13251A)
    static let warn = Color(light: 0xB45309, dark: 0xFBBF24)
    static let warnSoft = Color(light: 0xFDF3E1, dark: 0x2A2112)
    static let danger = Color(light: 0xB91C1C, dark: 0xF87171)
    static let dangerSoft = Color(light: 0xFDECEB, dark: 0x2C1616)

    /// `--r-md` und `--r-lg`
    static let radius: CGFloat = 10
    static let cardRadius: CGFloat = 14
}

extension Color {
    /// Farbe, die dem Hell- und Dunkelmodus folgt, aus zwei Hex-Werten (`0xRRGGBB`).
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor(light: light, dark: dark))
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }

    convenience init(light: UInt32, dark: UInt32) {
        self.init { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        }
    }

    /// `--bg` aus cockpit.css (`THEME` in layout.js).
    static let cockpitBackground = UIColor(light: 0xF7F5F1, dark: 0x141311)
    /// `--accent`
    static let cockpitAccent = UIColor(light: 0xC2410C, dark: 0xFB923C)
}
