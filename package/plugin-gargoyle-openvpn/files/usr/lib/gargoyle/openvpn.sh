#!/bin/sh

SSLVARIANT="mbedtls"
which $SSLVARIANT || SSLVARIANT="openssl"
which $SSLVARIANT || echo "ERROR: no SSL library available"

# global config directory
OPENVPN_DIR="/etc/openvpn"

# init script
OPENVPN_INIT_SCRIPT="/etc/init.d/openvpn"

# Assume time values are this many bits
# This is needed for setting expiration of certs to max
TIME_BITS=32

server_regenerate_credentials="false"

##################################################
# detect path for EASY RSA automatically
#
# if we're on a system other than debian/gargoyle
# these may need to be updated.  
#
# If EASY_RSA_PATH variable is exported in calling shell script
# that will get detected here and used
#
################################################################
if [ -z "$EASY_RSA_PATH" ] ; then
	debian_ubuntu_easyrsa_path="/usr/share/doc/openvpn/examples/easy-rsa/3.0"
	gargoyle_easyrsa_path="/usr/lib/easy-rsa"

	if [ -d "$debian_ubuntu_easyrsa_path" ] ; then
		EASY_RSA_PATH="$debian_ubuntu_easyrsa_path"
	elif [ -d "$gargoyle_easyrsa_path" ] ; then
		EASY_RSA_PATH="$gargoyle_easyrsa_path"
	fi
fi
if [ -z "$EASY_RSA_PATH" ] ; then
	echo "ERROR: could not find easy-rsa library, exiting"
	exit
fi

EXPIRATION_MAX=99999
if [ "$TIME_BITS" -lt 64 ] ; then
	#handle 2038 bug the best we can
	year=$(date +%Y)
	year_day=$(date +%j | awk '{printf "%d", $1}')
	EXPIRATION_MAX=$(( (365*(2038-$year)) - $year_day  ))
fi

random_string()
{
	if [ ! -n "$1" ];
		then LEN=15
		else LEN="$1"
	fi

	echo $(</dev/urandom tr -dc a-z | head -c $LEN) # generate a random string
}

load_def()
{
	passed_var_def="$1"
	vpn_var="$2"
	default="$3"

	result=""
	if [ -z "$passed_var_def" ] ; then passed_var_def=$default ; fi
	if [ "$passed_var_def" = "true" ] || [ "$passed_var_def" = "1" ] ; then result="$vpn_var" ; fi
	
	printf "$result"
}

copy_if_diff()
{
	new_file="$1"
	old_file="$2"

	if   [ ! -f "$new_file" ] ; then
		return
	elif [ ! -f "$old_file" ] ; then
		cp "$new_file" "$old_file"
	else
		old_md5=$(md5sum "$old_file")
		old_md5=${old_md5% *}
		new_md5=$(md5sum "$new_file")
		new_md5=${new_md5% *}
		if [ "$old_md5" != "$new_md5" ] ; then
			cp "$new_file" "$old_file"
		fi	
	fi
}

create_server_conf()
{
	#required vars
	openvpn_server_internal_ip="$1"
	openvpn_netmask="$2"
	openvpn_port="$3"
	
	#optional vars
	openvpn_server_local_subnet_ip="$4"
	openvpn_server_local_subnet_mask="$5"

	#optional vars, but with defaults
	openvpn_protocol="$6"
	if [ -z "$openvpn_protocol" ] ; then openvpn_protocol="udp" ; fi
	if [ "$openvpn_protocol" = "tcp" ] ; then openvpn_protocol="tcp-server" ; fi

	openvpn_cipher="$7"
	if [ -z "$openvpn_cipher" ] ; then openvpn_cipher="AES-256-CBC" ; fi

	openvpn_client_to_client=$(load_def "$8" "client-to-client" "false")
	openvpn_duplicate_cn=$(load_def "${9}" "duplicate-cn" "false")
	openvpn_pool="${10}"
	openvpn_redirect_gateway=$(load_def "${11}" "push \"redirect-gateway def1\"" "true")
	openvpn_regenerate_cert="${12}"

	openvpn_extra_subnets="${13}"

	if [ -n "$openvpn_pool" ] ; then
		openvpn_pool="ifconfig-pool $openvpn_pool"
	fi

	if [ ! -f "$OPENVPN_DIR/ca.crt" ]  || [ ! -f "$OPENVPN_DIR/dh.pem" ] || [ ! -f "$OPENVPN_DIR/server.crt" ] || [ ! -f "$OPENVPN_DIR/server.key" ] || [ ! -f "$OPENVPN_DIR/ta.key" ] ; then
		openvpn_regenerate_cert="true"
	fi
	server_regenerate_credentials="$openvpn_regenerate_cert"

	#make necessary directories
	mkdir -p "$OPENVPN_DIR/client_conf"
	mkdir -p "$OPENVPN_DIR/ccd"
	mkdir -p "$OPENVPN_DIR/route_data"

	mkdir -p /var/run
	touch /var/run/openvpn_status
	if [ ! -h /etc/openvpn/current_status ] ; then
		rm -rf /etc/openvpn/current_status
		ln -s  /var/run/openvpn_status /etc/openvpn/current_status 
	fi

	random_dir_num=$(random_string)
	random_dir="/tmp/ovpn-client-${random_dir_num}"
	mkdir -p "$random_dir"

	#generate dh.pem if necessary
	if [ "$openvpn_regenerate_cert" = "true" ] || [ "$openvpn_regenerate_cert" = "1" ] ; then
		cd "$random_dir"
		cp -r "$EASY_RSA_PATH/"* .

		name=$( random_string 15 )
		random_domain=$( random_string 15 )
		cat << 'EOF' >vars
set_var EASYRSA_BATCH "yes"
set_var EASYRSA_SILENT "yes"
set_var EASYRSA_RAND_SN "no"
set_var EASYRSA_DN "org"
set_var EASYRSA_KEY_SIZE 1024
set_var EASYRSA_REQ_COUNTRY "??"
set_var EASYRSA_REQ_PROVINCE "UnknownProvince"
set_var EASYRSA_REQ_CITY "UnknownCity"
set_var EASYRSA_REQ_ORG "UnknownOrg"
set_var EASYRSA_REQ_OU "UnknownOrgUnit"
EOF
cat << EOF >>vars
set_var EASYRSA_CA_EXPIRE $EXPIRATION_MAX
set_var EASYRSA_CERT_EXPIRE $EXPIRATION_MAX
set_var EASYRSA_REQ_EMAIL '$name@$random_domain.com'
set_var EASYRSA '$random_dir'
set_var EASYRSA_PKI '$random_dir/keys'
set_var EASYRSA_OPENSSL "$SSLVARIANT"
EOF
		./easyrsa init-pki
		./easyrsa gen-dh
		./easyrsa build-ca nopass
		./easyrsa build-server-full server nopass
		openvpn --genkey secret ta.key
		mkdir -p ./keys/issued/ ./keys/certs_by_serial/
		./easyrsa gen-crl
		cp keys/issued/server.crt keys/private/server.key keys/ca.crt keys/private/ca.key keys/dh.pem keys/index.txt keys/index.txt.attr keys/serial keys/crl.pem ta.key "$OPENVPN_DIR"/
	fi

	touch "$OPENVPN_DIR/server.conf"
	touch "$OPENVPN_DIR/route_data/server"
	touch "$random_dir/route_data_server"

	# server config
	cat << EOF >"$random_dir/server.conf"
mode                  server
port                  $openvpn_port
proto                 $openvpn_protocol
tls-server
ifconfig              $openvpn_server_internal_ip $openvpn_netmask
topology              subnet
client-config-dir     $OPENVPN_DIR/ccd
$openvpn_client_to_client

$openvpn_duplicate_cn
$openvpn_pool

data-ciphers          $openvpn_cipher

dev                   tun
keepalive             25 180
status                /var/run/openvpn_status
verb                  3


dh                    $OPENVPN_DIR/dh.pem
ca                    $OPENVPN_DIR/ca.crt
cert                  $OPENVPN_DIR/server.crt
key                   $OPENVPN_DIR/server.key
tls-auth              $OPENVPN_DIR/ta.key 0

persist-key
persist-tun

push "topology subnet"
push "route-gateway $openvpn_server_internal_ip"
$openvpn_redirect_gateway
EOF
	
	if [ -n "$openvpn_redirect_gateway" ] ; then
		touch "$OPENVPN_DIR/block_non_openvpn"
	else
		rm -rf "$OPENVPN_DIR/block_non_openvpn"
	fi

	if [ -n "$openvpn_server_local_subnet_ip" ] && [ -n "$openvpn_server_local_subnet_mask" ] ; then
		# save routes -- we need to update all route lines 
		# once all client ccd files are in place on the server
		echo "$openvpn_server_local_subnet_ip $openvpn_server_local_subnet_mask $openvpn_server_internal_ip" > "$random_dir/route_data_server"
	fi
	if [ -n "$openvpn_extra_subnets" ] ; then
		for openvpn_extra_subnet in $openvpn_extra_subnets ; do
			esubnet_ip=$(echo "$openvpn_extra_subnet" | cut -d '_' -f 1)
			esubnet_mask=$(echo "$openvpn_extra_subnet" | cut -d '_' -f 2)
			echo "$esubnet_ip $esubnet_mask $openvpn_server_internal_ip" >> "$random_dir/route_data_server"
		done
	fi

	copy_if_diff "$random_dir/server.conf"        "$OPENVPN_DIR/server.conf"
	copy_if_diff "$random_dir/route_data_server"  "$OPENVPN_DIR/route_data/server"

	cd /tmp
	rm -rf "$random_dir"
}



create_allowed_client_conf()
{
	#required
	openvpn_client_id="$1"
	openvpn_client_remote="$2"

	#optional
	openvpn_client_internal_ip="$3"
	openvpn_client_local_subnet_ip="$4"
	openvpn_client_local_subnet_mask="$5"

	#load from server config
	openvpn_protocol=$( awk ' $1 ~ /proto/     { print $2 } ' /etc/openvpn/server.conf )
	openvpn_port=$(     awk ' $1 ~ /port/      { print $2 } ' /etc/openvpn/server.conf )
	openvpn_netmask=$(  awk ' $1 ~ /ifconfig/  { print $3 } ' /etc/openvpn/server.conf )
	openvpn_cipher=$(   awk ' $1 ~ /cipher/    { print $2 } ' /etc/openvpn/server.conf )
	if [ "$openvpn_protocol" = "tcp-server" ] ; then
		openvpn_protocol="tcp-client"
	fi

	openvpn_regenerate_cert="$6"
	client_enabled="$7"
	if [ -z "$client_enabled" ] ; then
		client_enabled="true"
	fi

	client_conf_dir="$OPENVPN_DIR/client_conf/$openvpn_client_id"
	if [ ! -f "$client_conf_dir/$openvpn_client_id.crt" ]  || [ ! -f "$client_conf_dir/$openvpn_client_id.key" ] || [ ! -f "$client_conf_dir/ca.crt" ]  ; then
		openvpn_regenerate_cert="true"
	fi

	#if we regenerated server credentials, force regeneration of client credentials too
	if [ "$server_regenerate_credentials" = "true" ] || [ "$server_regenerate_credentials" = "1" ] ; then
		openvpn_regenerate_cert="true"
	fi

	mkdir -p "$OPENVPN_DIR/client_conf"
	mkdir -p "$OPENVPN_DIR/ccd"
	mkdir -p "$OPENVPN_DIR/route_data"
	
	random_dir_num=$(random_string)
	random_dir="/tmp/ovpn-client-${random_dir_num}"
	mkdir -p "$random_dir"

	if [ "$openvpn_regenerate_cert" = "true" ] || [ "$openvpn_regenerate_cert" = "1" ] ; then
		cd "$random_dir"
		cp -r "$EASY_RSA_PATH/"* .

		random_domain=$( random_string 15 )
		cat << 'EOF' >vars
set_var EASYRSA_BATCH "yes"
set_var EASYRSA_SILENT "yes"
set_var EASYRSA_RAND_SN "no"
set_var EASYRSA_DN "org"
set_var EASYRSA_KEY_SIZE 1024
set_var EASYRSA_REQ_COUNTRY "??"
set_var EASYRSA_REQ_PROVINCE "UnknownProvince"
set_var EASYRSA_REQ_CITY "UnknownCity"
set_var EASYRSA_REQ_ORG "UnknownOrg"
set_var EASYRSA_REQ_OU "UnknownOrgUnit"
EOF
cat << EOF >>vars
set_var EASYRSA_CA_EXPIRE $EXPIRATION_MAX
set_var EASYRSA_CERT_EXPIRE $EXPIRATION_MAX
set_var EASYRSA_REQ_EMAIL '$openvpn_client_id@$random_domain.com'
set_var EASYRSA '$random_dir'
set_var EASYRSA_PKI '$random_dir/keys'
set_var EASYRSA_OPENSSL "$SSLVARIANT"
EOF

		./easyrsa init-pki
		mkdir -p ./keys/issued/ ./keys/certs_by_serial/
		cp "$OPENVPN_DIR/ca.crt" "$OPENVPN_DIR/dh.pem" "$OPENVPN_DIR/index.txt" "$OPENVPN_DIR/index.txt.attr" "$OPENVPN_DIR/serial" ./keys/
		cp "$OPENVPN_DIR/server.crt" ./keys/issued/
		cp "$OPENVPN_DIR/server.key" "$OPENVPN_DIR/ca.key" ./keys/private/

		./easyrsa build-client-full "$openvpn_client_id" nopass
		./easyrsa gen-crl

		mkdir -p "$OPENVPN_DIR/client_conf/$openvpn_client_id"
		cp "keys/issued/$openvpn_client_id.crt" "keys/private/$openvpn_client_id.key" "$OPENVPN_DIR/ca.crt" "$OPENVPN_DIR/ta.key" "$client_conf_dir/"
		cp "keys/index.txt" "keys/index.txt.attr" "keys/serial" "keys/crl.pem" "$OPENVPN_DIR/"
	fi

	if [ -n "$openvpn_client_local_subnet_ip" ] && [ -n "$openvpn_client_local_subnet_mask" ] ; then
		echo "ipaddr    $openvpn_client_local_subnet_ip"    >'network'
		echo "netmask   $openvpn_client_local_subnet_mask" >>'network'
		mv network "$client_conf_dir/network"
	fi

	if [ "$client_enabled" != "false" ] && [ "$client_enabled" != "0" ] ; then
		if [ ! -e "$OPENVPN_DIR/$openvpn_client_id.crt" ] ; then
			ln -s "$OPENVPN_DIR/client_conf/$openvpn_client_id/$openvpn_client_id.crt" "$OPENVPN_DIR/$openvpn_client_id.crt"
		fi
		touch "$OPENVPN_DIR/route_data_${openvpn_client_id}"
		touch "$random_dir/route_data_${openvpn_client_id}"
	else
		if [ -e "$OPENVPN_DIR/$openvpn_client_id.crt" ] ; then
			rm "$OPENVPN_DIR/$openvpn_client_id.crt"
		fi
		if [ -e "$OPENVPN_DIR/route_data/${openvpn_client_id}" ] ; then
			rm "$OPENVPN_DIR/route_data/${openvpn_client_id}" 
		fi
	fi

	if [ -e  "$OPENVPN_DIR/block_non_openvpn" ] ; then
		touch "$OPENVPN_DIR/client_conf/${openvpn_client_id}/block_non_openvpn"
	else
		rm -rf "$OPENVPN_DIR/client_conf/${openvpn_client_id}/block_non_openvpn"
	fi	

	touch "$random_dir/ccd_${openvpn_client_id}"
	touch "$OPENVPN_DIR/ccd/${openvpn_client_id}"

	cat << EOF >"$random_dir/$openvpn_client_id.conf"

client
remote          $openvpn_client_remote $openvpn_port
dev             tun
proto           $openvpn_protocol
resolv-retry    infinite
remote-cert-tls server
verb            3

data-ciphers    $openvpn_cipher

ca              ca.crt
cert            $openvpn_client_id.crt
key             $openvpn_client_id.key
tls-auth        ta.key 1

nobind
persist-key
persist-tun

push-peer-info
EOF

	#update info about assigned ip/subnet
	if [ -n "$openvpn_client_internal_ip" ] ; then
		echo "ifconfig-push $openvpn_client_internal_ip $openvpn_netmask"                                                                      > "$random_dir/ccd_${openvpn_client_id}"
		if [ -n "$openvpn_client_local_subnet_ip" ] && [ -n "$openvpn_client_local_subnet_mask" ] ; then
			echo "iroute $openvpn_client_local_subnet_ip $openvpn_client_local_subnet_mask"                                               >> "$random_dir/ccd_${openvpn_client_id}"

			# save routes -- we need to update all route lines 
			# once all client ccd files are in place on the server
			if  [ "$client_enabled" != "false" ] && [ "$client_enabled" != "0" ] ; then
				echo "$openvpn_client_local_subnet_ip $openvpn_client_local_subnet_mask $openvpn_client_internal_ip \"$openvpn_client_id\"" > "$random_dir/route_data_${openvpn_client_id}"
			fi
		fi
	fi
	
	copy_if_diff "$random_dir/$openvpn_client_id.conf"          "$client_conf_dir/$openvpn_client_id.conf"
	if [ ! -h "$client_conf_dir/$openvpn_client_id.ovpn" ] ; then
		ln -s "$client_conf_dir/$openvpn_client_id.conf" "$client_conf_dir/$openvpn_client_id.ovpn"	
	fi
	copy_if_diff "$random_dir/ccd_${openvpn_client_id}"         "$OPENVPN_DIR/ccd/${openvpn_client_id}"
	if  [ "$client_enabled" != "false" ] && [ "$client_enabled" != "0" ] ; then
		copy_if_diff "$random_dir/route_data_${openvpn_client_id}"  "$OPENVPN_DIR/route_data/${openvpn_client_id}"
	fi

	cd /tmp
	rm -rf "$random_dir"
}


update_routes()
{
	openvpn_server_internal_ip=$(awk ' $1 ~ /ifconfig/  { print $2 } ' /etc/openvpn/server.conf )

	# Change "Internal Field Separator" (IFS variable)
	# which controls separation in for loop variables
	IFS_ORIG="$IFS"
	IFS_LINEBREAK="$(printf '\n\r')"
	IFS="$IFS_LINEBREAK"
	
	random_dir_num=$(random_string)
	random_dir="/tmp/ovpn-client-${random_dir_num}"
	mkdir -p "$random_dir"
	cp -r "$OPENVPN_DIR/ccd" "$random_dir"/
	cp -r "$OPENVPN_DIR/server.conf" "$random_dir"/
	
	# clear out old route data
	for client_ccd_file in $(ls "$random_dir/ccd/"* 2>/dev/null) ; do
		sed -i '/^push .*route/d' "$client_ccd_file"
	done
	sed -i '/^route /d' "$random_dir/server.conf"
	
	# set updated route data
	route_lines=$( cat "$OPENVPN_DIR/route_data/"* )
	for route_line in $route_lines ; do
		line_parts=$(  echo "$route_line" | awk '{ print NF }')
		subnet_ip=$(   echo "$route_line" | awk '{ print $1 }')
		subnet_mask=$( echo "$route_line" | awk '{ print $2 }')
		openvpn_ip=$(  echo "$route_line" | awk '{ print $3 }')

		if [ $line_parts -gt 3 ] ; then
			# routes for client subnet
			config_name=$( echo "$route_line" | sed 's/\"$//g' | sed 's/^.*\"//g')
			for client_ccd_file in $(ls "$random_dir/ccd/"* 2>/dev/null) ; do
				client_ccd_id=$(echo "$client_ccd_file" | sed -n -e 's/^.*ccd\///p')
				vpn_gwy=$( uci get openvpn_gargoyle.$client_ccd_id.prefer_vpngateway 2&>1)
				if [ "$random_dir/ccd/$config_name" != "$client_ccd_file" ] ; then
					if [ "$vpn_gwy" == "1" ] ; then
						echo "push \"route $subnet_ip $subnet_mask vpn_gateway\"" >> "$client_ccd_file"
					else
						echo "push \"route $subnet_ip $subnet_mask $openvpn_server_internal_ip\"" >> "$client_ccd_file"
					fi
				fi
			done
			echo "route $subnet_ip $subnet_mask $openvpn_ip" >> "$random_dir/server.conf"

		else
			# routes for server subnet
			for client_ccd_file in $(ls "$random_dir/ccd/"* 2>/dev/null) ; do
				client_ccd_id=$(echo "$client_ccd_file" | sed -n -e 's/^.*ccd\///p')
				vpn_gwy=$( uci get openvpn_gargoyle.$client_ccd_id.prefer_vpngateway 2&>1)
				if [ "$vpn_gwy" == "1" ] ; then
					echo "push \"route $subnet_ip $subnet_mask vpn_gateway\"" >> "$client_ccd_file"
				else
					echo "push \"route $subnet_ip $subnet_mask $openvpn_ip\"" >> "$client_ccd_file"
				fi
			done
		fi
	done

	cd "$random_dir/ccd/"
	for client_ccd_file in $(ls 2>/dev/null) ; do
		copy_if_diff "$client_ccd_file" "$OPENVPN_DIR/ccd/$client_ccd_file"
	done
	cd "$random_dir"
	copy_if_diff "server.conf" "$OPENVPN_DIR/server.conf"

	cd /tmp
	rm -rf "$random_dir"
	
	# change IFS back now that we're done
	IFS="$IFS_ORIG"
}

remove_allowed_client()
{
	client_id="$1"
	remove_client_from_userlist "$client_id"
	revoke_client_certificate "$current_client"
	rm -rf "$OPENVPN_DIR/client_conf/$current_client"
	rm -rf "$OPENVPN_DIR/$current_client.crt"
	rm -rf "$OPENVPN_DIR/route_data/$current_client"
	rm -rf "$OPENVPN_DIR/ccd/$current_client"
}

revoke_client_certificate()
{
	random_dir_num=$(random_string)
	random_dir="/tmp/ovpn-client-${random_dir_num}"
	mkdir -p "$random_dir"
	cd "$random_dir"
	cp -r "$EASY_RSA_PATH/"* .

	cat << 'EOF' >vars
set_var EASYRSA_BATCH "yes"
set_var EASYRSA_SILENT "yes"
set_var EASYRSA_RAND_SN "no"
set_var EASYRSA_DN "org"
set_var EASYRSA_KEY_SIZE 1024
set_var EASYRSA_REQ_COUNTRY "??"
set_var EASYRSA_REQ_PROVINCE "UnknownProvince"
set_var EASYRSA_REQ_CITY "UnknownCity"
set_var EASYRSA_REQ_ORG "UnknownOrg"
set_var EASYRSA_REQ_OU "UnknownOrgUnit"
EOF
cat << EOF >>vars
set_var EASYRSA_CA_EXPIRE $EXPIRATION_MAX
set_var EASYRSA_CERT_EXPIRE $EXPIRATION_MAX
set_var EASYRSA_REQ_EMAIL '$openvpn_client_id@$random_domain.com'
set_var EASYRSA_REQ_CN '$openvpn_client_id'
set_var EASYRSA '$random_dir'
set_var EASYRSA_PKI '$random_dir/keys'
set_var EASYRSA_OPENSSL "$SSLVARIANT"
EOF
	
	./easyrsa init-pki
	mkdir -p ./keys/issued/ ./keys/certs_by_serial/
	cp "$OPENVPN_DIR/ca.crt" "$OPENVPN_DIR/dh.pem" "$OPENVPN_DIR/index.txt" "$OPENVPN_DIR/index.txt.attr" "$OPENVPN_DIR/serial" ./keys/
	cp "$OPENVPN_DIR/server.crt" "$OPENVPN_DIR/client_conf/$1/$1.crt" ./keys/issued/
	cp "$OPENVPN_DIR/server.key" "$OPENVPN_DIR/ca.key" ./keys/private/

	./easyrsa revoke $1
	./easyrsa gen-crl

	cp "keys/index.txt" "keys/index.txt.attr" "keys/serial" "keys/crl.pem" "$OPENVPN_DIR/"

	cd /tmp
	rm -rf "$random_dir"
}

remove_client_from_userlist()
{
	touch "$OPENVPN_DIR/verified-userlist"
	client_id="$1"
	client_found=$(grep -w "^$client_id" "$OPENVPN_DIR/verified-userlist")
	if [ -n $client_found ] ; then
		grep -wv "^$client_id" "$OPENVPN_DIR/verified-userlist" > "$OPENVPN_DIR/vusrlst-temp"
		mv "$OPENVPN_DIR/vusrlst-temp" "$OPENVPN_DIR/verified-userlist"
	fi
}

add_client_to_userlist()
{
	touch "$OPENVPN_DIR/verified-userlist"
	client_id="$1"
	client_found=$(grep -w "^$client_id" "$OPENVPN_DIR/verified-userlist")
	[ -z $client_found ] && echo $client_id >> "$OPENVPN_DIR/verified-userlist"
}

generate_crl()
{
	random_dir_num=$(random_string)
	random_dir="/tmp/ovpn-client-${random_dir_num}"
	mkdir -p "$random_dir"
	cd "$random_dir"
	cp -r "$EASY_RSA_PATH/"* .

	cat << 'EOF' >vars
set_var EASYRSA_BATCH "yes"
set_var EASYRSA_SILENT "yes"
set_var EASYRSA_RAND_SN "no"
set_var EASYRSA_DN "org"
set_var EASYRSA_KEY_SIZE 1024
set_var EASYRSA_REQ_COUNTRY "??"
set_var EASYRSA_REQ_PROVINCE "UnknownProvince"
set_var EASYRSA_REQ_CITY "UnknownCity"
set_var EASYRSA_REQ_ORG "UnknownOrg"
set_var EASYRSA_REQ_OU "UnknownOrgUnit"
EOF
cat << EOF >>vars
set_var EASYRSA_CA_EXPIRE $EXPIRATION_MAX
set_var EASYRSA_CERT_EXPIRE $EXPIRATION_MAX
set_var EASYRSA_REQ_EMAIL '$openvpn_client_id@$random_domain.com'
set_var EASYRSA_REQ_CN '$openvpn_client_id'
set_var EASYRSA '$random_dir'
set_var EASYRSA_PKI '$random_dir/keys'
set_var EASYRSA_OPENSSL "$SSLVARIANT"
EOF
	
	./easyrsa init-pki
	mkdir -p ./keys/issued/ ./keys/certs_by_serial/
	cp "$OPENVPN_DIR/ca.crt" "$OPENVPN_DIR/dh.pem" "$OPENVPN_DIR/index.txt" "$OPENVPN_DIR/index.txt.attr" "$OPENVPN_DIR/serial" ./keys/
	cp "$OPENVPN_DIR/server.crt" ./keys/issued/
	cp "$OPENVPN_DIR/server.key" "$OPENVPN_DIR/ca.key" ./keys/private/

	./easyrsa gen-crl

	cp "keys/index.txt" "keys/index.txt.attr" "keys/serial" "keys/crl.pem" "$OPENVPN_DIR/"

	cd /tmp
	rm -rf "$random_dir"
}

generate_test_configuration()
{
	# server
	create_server_conf	10.8.0.1           \
				255.255.255.0      \
				7099               \
				192.168.15.0       \
				255.255.255.0      \
				"tcp"              \
				"BF-CBC"           \
				"128"              \
				"true"             \
				"false"            \
				""                 \
				"true"             \
				"false"

	# clients
	create_allowed_client_conf "client1" "[YOUR_SERVER_IP]" "10.8.0.2" "" "" "false" "true"
	create_allowed_client_conf "client2" "[YOUR_SERVER_IP]" "10.8.0.3" "192.168.16.0" "255.255.255.0" "false" "true"
	create_allowed_client_conf "client3" "[YOUR_SERVER_IP]" "10.8.0.4" "192.168.17.0" "255.255.255.0" "false" "true"

	# update routes
	update_routes 
}

regenerate_allowed_client_from_uci()
{
	section="$1"
	ac_vars="id remote ip subnet_ip subnet_mask regenerate_credentials enabled"
	for var in $ac_vars ; do
		config_get "$var" "$section" "$var"
	done
	
	config_get "duplicate_cn" "server" "duplicate_cn"
	if [ "$duplicate_cn" = "true" ] || [  "$duplicate_cn" = "1" ] ; then
		ip=""
		subnet_ip=""
		subnet_mask=""
	fi	
	

	if [ "$enabled" != "false" ] && [ "$enabled" != "0" ] ; then
		create_allowed_client_conf "$id" "$remote" "$ip" "$subnet_ip" "$subnet_mask" "false" "$enabled"
		add_client_to_userlist "$id"
	else
		remove_client_from_userlist "$id"
	fi
}

regenerate_server_and_allowed_clients_from_uci()
{
	. /lib/functions.sh
	config_load "openvpn_gargoyle"
	
	server_vars="internal_ip internal_mask port proto cipher client_to_client duplicate_cn redirect_gateway subnet_access regenerate_credentials subnet_ip subnet_mask pool extra_subnet"
	for var in $server_vars ; do
		config_get "$var" "server" "$var"
	done

	create_server_conf	"$internal_ip"             \
				"$internal_mask"           \
				"$port"                    \
				"$subnet_ip"               \
				"$subnet_mask"             \
				"$proto"                   \
				"$cipher"                  \
				"$client_to_client"        \
				"$duplicate_cn"            \
				"$pool"                    \
				"$redirect_gateway"        \
				"$regenerate_credentials"  \
				"$extra_subnet"

	server_regenerate_credentials="$regenerate_credentials"
	config_foreach regenerate_allowed_client_from_uci "allowed_client"

	for current_client in "$OPENVPN_DIR/client_conf/"* ; do
		if [ -d "$current_client" ] ; then
			current_client=$(echo $current_client | sed 's/^.*\///g')
			client_def=$(uci get openvpn_gargoyle.${current_client} 2>/dev/null)
			if [ "$client_def" != "allowed_client" ] ; then
				remove_allowed_client "$current_client"
			fi
		fi
	done
	
	update_routes
}

# apt-get update
# apt-get install aptitude
# aptitude install -y openvpn
# generate_test_configuration


