import SwiftUI

struct PairingView: View {
    @Binding var isPresented: Bool
    var onPaired: () -> Void
    
    @State private var pin: String = ""
    @State private var autoConnect: Bool = true
    @State private var errorMessage: String? = nil
    @State private var isLoading: Bool = false
    
    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            
            VStack(spacing: 30) {
                HStack {
                    Button(action: { isPresented = false }) {
                        Image(systemName: "xmark")
                            .font(.title2)
                            .foregroundColor(Theme.ink)
                            .padding()
                    }
                    Spacer()
                }
                
                Spacer()
                
                Text("📱")
                    .font(.system(size: 64))
                
                Text("Nhập Mã PIN")
                    .font(.system(size: 32, weight: .black))
                    .foregroundColor(Theme.ink)
                
                Text("Vui lòng xem mã PIN 4 số hiển thị trên màn hình PC của bạn.")
                    .multilineTextAlignment(.center)
                    .foregroundColor(Theme.inkSoft)
                    .padding(.horizontal)
                
                TextField("XXXX", text: $pin)
                    .font(.system(size: 40, weight: .black, design: .monospaced))
                    .multilineTextAlignment(.center)
                    .keyboardType(.numberPad)
                    .padding()
                    .neoStyle()
                    .frame(width: 200)
                    .onChange(of: pin) { newValue in
                        if newValue.count > 4 {
                            pin = String(newValue.prefix(4))
                        }
                    }
                
                if let error = errorMessage {
                    Text(error)
                        .foregroundColor(Theme.viRed)
                        .font(.callout)
                        .bold()
                }
                
                Button(action: {
                    autoConnect.toggle()
                }) {
                    HStack {
                        Image(systemName: autoConnect ? "checkmark.square.fill" : "square")
                            .foregroundColor(autoConnect ? Theme.coral : Theme.ink)
                        Text("Tự động kết nối lần sau")
                            .foregroundColor(Theme.ink)
                            .fontWeight(.bold)
                    }
                }
                
                Button(action: verifyPin) {
                    Text(isLoading ? "Đang kiểm tra..." : "Kết Nối")
                        .font(.title3.bold())
                        .foregroundColor(Theme.paper)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Theme.ink)
                        .neoStyle()
                }
                .disabled(pin.count < 4 || isLoading)
                .padding(.horizontal, 40)
                
                Spacer()
            }
        }
    }
    
    private func verifyPin() {
        isLoading = true
        errorMessage = nil
        
        NetworkManager.shared.verifyPIN(pin, autoConnect: autoConnect) { success, error in
            isLoading = false
            if success {
                onPaired()
            } else {
                errorMessage = error ?? "Lỗi kết nối"
            }
        }
    }
}
