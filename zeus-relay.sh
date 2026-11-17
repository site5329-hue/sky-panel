#!/bin/bash

if [ "$EUID" -ne 0 ]; then
  echo "Error: This script must be run as root."
  exit 1
fi

while true; do
    echo -e "\n============================================"
    echo -e "\e[36m1. Install / Update SOCKS5 Proxy (GOST)\e[0m"
    echo -e "\e[36m2. Uninstall & Remove Proxy\e[0m"
    echo -e "\e[36m3. Pause Proxy (Temporary Stop)\e[0m"
    echo -e "\e[36m4. Resume Proxy (Start)\e[0m"
    echo -e "\e[36m5. View Traffic Statistics\e[0m"
    echo -e "\e[36m6. Exit\e[0m"
    echo -e "============================================"
    read -p "Enter your choice (1-6): " choice < /dev/tty

    if [ "$choice" == "2" ]; then
        echo -e "\e[33mUninstalling GOST SOCKS5 Proxy...\e[0m"
        systemctl stop gost 2>/dev/null
        systemctl disable gost 2>/dev/null
        
        if [ -f /etc/systemd/system/gost.service ]; then
            PORT_TO_REMOVE=$(grep -oP '(?<=@:)\d+' /etc/systemd/system/gost.service)
            if [ -n "$PORT_TO_REMOVE" ]; then
                if command -v ufw >/dev/null 2>&1; then
                    ufw delete allow $PORT_TO_REMOVE/tcp 2>/dev/null
                elif command -v firewall-cmd >/dev/null 2>&1; then
                    firewall-cmd --zone=public --remove-port=$PORT_TO_REMOVE/tcp --permanent 2>/dev/null
                    firewall-cmd --reload 2>/dev/null
                fi
                iptables -D INPUT -p tcp --dport $PORT_TO_REMOVE 2>/dev/null
                iptables -D OUTPUT -p tcp --sport $PORT_TO_REMOVE 2>/dev/null
            fi
            rm -f /etc/systemd/system/gost.service
            systemctl daemon-reload
        fi

        rm -f /usr/local/bin/gost
        rm -f /etc/sysctl.d/99-gost-proxy.conf
        sysctl --system >/dev/null 2>&1

        echo -e "\e[32mUninstallation complete! Returning to menu...\e[0m"
        sleep 2
    elif [ "$choice" == "3" ]; then
        echo -e "\e[33mPausing GOST Service...\e[0m"
        systemctl stop gost
        echo -e "\e[32mProxy is now temporarily stopped.\e[0m"
        sleep 2
    elif [ "$choice" == "4" ]; then
        echo -e "\e[33mResuming GOST Service...\e[0m"
        systemctl start gost
        echo -e "\e[32mProxy is now active.\e[0m"
        sleep 2
    elif [ "$choice" == "5" ]; then
        if [ -f /etc/systemd/system/gost.service ]; then
            CURRENT_PORT=$(grep -oP '(?<=@:)\d+' /etc/systemd/system/gost.service)
            DOWNLOAD=$(iptables -L OUTPUT -v -n -x | grep "spt:$CURRENT_PORT" | awk '{ sum=$2; split("B KB MB GB TB", v); for(i=1; sum>=1024 && i<5; i++) sum/=1024; printf "%.2f %s", sum, v[i] }')
            UPLOAD=$(iptables -L INPUT -v -n -x | grep "dpt:$CURRENT_PORT" | awk '{ sum=$2; split("B KB MB GB TB", v); for(i=1; sum>=1024 && i<5; i++) sum/=1024; printf "%.2f %s", sum, v[i] }')
            
            [[ -z "$DOWNLOAD" ]] && DOWNLOAD="0"
            [[ -z "$UPLOAD" ]] && UPLOAD="0"

            echo -e "\n\e[36m--- Traffic Statistics (Port $CURRENT_PORT) ---\e[0m"
            echo -e "Download (Server to User): \e[32m$DOWNLOAD\e[0m"
            echo -e "Upload (User to Server): \e[32m$UPLOAD\e[0m"
            echo -e "---------------------------------------"
        else
            echo -e "\e[31mProxy is not installed.\e[0m"
        fi
        read -p "Press Enter to return to menu..." < /dev/tty
    elif [ "$choice" == "1" ]; then
        break
    elif [ "$choice" == "6" ]; then
        exit 0
    else
        echo -e "\e[31mInvalid choice, please try again.\e[0m"
    fi
done

OS=""
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
fi

echo -e "\e[33mInstalling dependencies...\e[0m"
if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
    apt-get update -y
    apt-get install wget curl ufw gzip iproute2 iptables -y
elif [[ "$OS" == "centos" || "$OS" == "rhel" || "$OS" == "rocky" || "$OS" == "almalinux" || "$OS" == "fedora" ]]; then
    yum install wget curl firewalld gzip iproute iptables -y
else
    echo "Error: Unsupported OS."
    exit 1
fi

echo -e "\e[33mDownloading and configuring GOST...\e[0m"
wget -qO- https://github.com/ginuerzh/gost/releases/download/v2.11.5/gost-linux-amd64-2.11.5.gz | gzip -d > /usr/local/bin/gost
chmod +x /usr/local/bin/gost

PORT=1080
while ss -tuln | grep -qE "(:$PORT\b)"; do
    PORT=$((PORT + 1000))
done

PROXY_USER=$(tr -dc 'a-z' </dev/urandom | head -c 8)
PROXY_PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 12)

if command -v ufw >/dev/null 2>&1; then
    ufw allow $PORT/tcp
elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --zone=public --add-port=$PORT/tcp --permanent
    firewall-cmd --reload
fi

iptables -D INPUT -p tcp --dport $PORT 2>/dev/null
iptables -D OUTPUT -p tcp --sport $PORT 2>/dev/null
iptables -I INPUT -p tcp --dport $PORT
iptables -I OUTPUT -p tcp --sport $PORT

cat <<EOF > /etc/systemd/system/gost.service
[Unit]
Description=GOST SOCKS5 Proxy
After=network.target

[Service]
Type=simple
LimitNOFILE=65535
ExecStart=/usr/local/bin/gost -L=socks5://$PROXY_USER:$PROXY_PASS@:$PORT
Restart=always

[Install]
WantedBy=multi-user.target
EOF

cat <<EOF > /etc/sysctl.d/99-gost-proxy.conf
fs.file-max = 1048576
net.core.somaxconn = 8192
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.ip_local_port_range = 1024 65535
EOF
sysctl --system >/dev/null 2>&1

systemctl daemon-reload
systemctl enable gost
systemctl restart gost

SERVER_IP=$(curl -s -4 https://api.ipify.org)
SERVER_IPV6=$(curl -s -6 https://api64.ipify.org)

echo "============================================"
echo -e "\e[32mGOST SOCKS5 Proxy Installed Successfully!\e[0m"
echo "============================================"
echo "$PROXY_USER:$PROXY_PASS@$SERVER_IP:$PORT"
if [ -n "$SERVER_IPV6" ]; then
    echo "$PROXY_USER:$PROXY_PASS@[$SERVER_IPV6]:$PORT"
fi
echo "============================================"
