import Foundation
import Network
import Combine

class NetworkManager: ObservableObject {
    static let shared = NetworkManager()
    
    @Published var discoveredServers: [NWBrowser.Result] = []
    @Published var currentToken: String? = UserDefaults.standard.string(forKey: "visubly_token")
    @Published var currentServerURL: String? = UserDefaults.standard.string(forKey: "visubly_server_url")
    
    private var browser: NWBrowser?
    
    func startDiscovery() {
        let parameters = NWParameters()
        parameters.includePeerToPeer = true
        
        browser = NWBrowser(for: .bonjour(type: "_visubly._tcp", domain: "local."), using: parameters)
        
        browser?.stateUpdateHandler = { state in
            print("Browser state: \\(state)")
        }
        
        browser?.browseResultsChangedHandler = { [weak self] results, _ in
            DispatchQueue.main.async {
                self?.discoveredServers = Array(results)
            }
        }
        
        browser?.start(queue: .main)
    }
    
    func stopDiscovery() {
        browser?.cancel()
        browser = nil
    }
    
    func resolveAndPair(result: NWBrowser.Result, completion: @escaping (Bool) -> Void) {
        // Resolve endpoint to get IP and Port
        if case let .hostPort(host, port) = result.endpoint {
            let ipAddress = extractIP(from: host)
            let serverURL = "http:\\/\\/\\(ipAddress):\\(port.rawValue)"
            
            self.currentServerURL = serverURL
            UserDefaults.standard.set(serverURL, forKey: "visubly_server_url")
            
            // Check if we already have a valid token
            if let token = currentToken {
                verifyToken(token: token, url: serverURL) { isValid in
                    if isValid {
                        completion(true)
                    } else {
                        self.requestPairing(url: serverURL, completion: completion)
                    }
                }
            } else {
                requestPairing(url: serverURL, completion: completion)
            }
        } else {
            completion(false)
        }
    }
    
    private func extractIP(from host: NWEndpoint.Host) -> String {
        switch host {
        case .ipv4(let ipv4):
            // ipv4 debug description might include port, we just want the IP string
            // NWEndpoint.Host.ipv4 can be cast to string easily in real implementation
            // Using a simple workaround here
            let desc = String(describing: ipv4)
            return desc.components(separatedBy: "%").first ?? desc
        case .ipv6(let ipv6):
            return String(describing: ipv6)
        default:
            return String(describing: host)
        }
    }
    
    private func verifyToken(token: String, url: String, completion: @escaping (Bool) -> Void) {
        guard let reqUrl = URL(string: "\\(url)/api/videos?token=\\(token)") else {
            completion(false)
            return
        }
        
        URLSession.shared.dataTask(with: reqUrl) { data, response, error in
            DispatchQueue.main.async {
                if let httpRes = response as? HTTPURLResponse, httpRes.statusCode == 200 {
                    completion(true)
                } else {
                    completion(false)
                }
            }
        }.resume()
    }
    
    func requestPairing(url: String, completion: @escaping (Bool) -> Void) {
        guard let reqUrl = URL(string: "\\(url)/api/request-pairing") else {
            completion(false)
            return
        }
        
        var request = URLRequest(url: reqUrl)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                if let httpRes = response as? HTTPURLResponse, httpRes.statusCode == 200 {
                    completion(true) // Ready to enter PIN
                } else {
                    completion(false)
                }
            }
        }.resume()
    }
    
    func verifyPIN(_ pin: String, autoConnect: Bool, completion: @escaping (Bool, String?) -> Void) {
        guard let baseUrl = currentServerURL,
              let reqUrl = URL(string: "\\(baseUrl)/api/verify-pairing") else {
            completion(false, nil)
            return
        }
        
        var request = URLRequest(url: reqUrl)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body = ["pin": pin]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        
        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                if let data = data,
                   let json = try? JSONDecoder().decode(PairingResponse.self, from: data),
                   json.success,
                   let token = json.token {
                    
                    self.currentToken = token
                    if autoConnect {
                        UserDefaults.standard.set(token, forKey: "visubly_token")
                    }
                    
                    completion(true, nil)
                } else {
                    completion(false, "Mã PIN không đúng hoặc đã hết hạn")
                }
            }
        }.resume()
    }
    
    func fetchVideos(completion: @escaping ([VideoItem]) -> Void) {
        guard let baseUrl = currentServerURL,
              let token = currentToken,
              let reqUrl = URL(string: "\\(baseUrl)/api/videos?token=\\(token)") else {
            completion([])
            return
        }
        
        URLSession.shared.dataTask(with: reqUrl) { data, response, error in
            DispatchQueue.main.async {
                if let data = data,
                   let videos = try? JSONDecoder().decode([VideoItem].self, from: data) {
                    completion(videos)
                } else {
                    completion([])
                }
            }
        }.resume()
    }
}
