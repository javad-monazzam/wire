
```
sudo apt update && apt upgrade -y




sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
NODE_MAJOR=20
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt-get update
sudo apt-get install nodejs -y




git clone https://github.com/lokidv/jwpn.git
mv jwpn/ /home
cd /home
cd jwpn




npm i

chmod +x wireguard-install.sh
./wireguard-install.sh
nano /etc/systemd/system/jwpn.service

[Unit]
Description=Tunnel WireGuard with udp2raw
After=network.target

[Service]
Type=simple
User=root
ExecStart=sudo node /home/jwpn/main.js
Restart=no

[Install]
WantedBy=multi-user.target

systemctl enable --now jwpn.service 


you should upload install file to server

nano install.sh

chmod +x install.sh
./install.sh

or


pm2 start main.js
pm2 list
```
for crontab

```
export VISUAL=nano; crontab -e

* 12 * * * reboot


```

for transfer
```
cd /
tar czvf openvpn_backup.tar.gz /etc/openvpn/ /etc/openvpn/easy-rsa/
scp openvpn_backup.tar.gz root@ip:/root
tar xzvf openvpn_backup.tar.gz
sudo systemctl stop openvpn@server.service
rm -r /etc/openvpn/
mv etc/openvpn /etc
nano /etc/systemd/system/udp2raw.service
```

