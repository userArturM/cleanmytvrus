import base64, pathlib, socket, struct, subprocess, tempfile, threading
binary = pathlib.Path(__file__).parent/'adb-tests'
CNXN,AUTH,OPEN,OKAY,WRTE,CLSE = [int.from_bytes(s,'little') for s in [b'CNXN',b'AUTH',b'OPEN',b'OKAY',b'WRTE',b'CLSE']]
def exact(c,n):
    data=b''
    while len(data)<n:
        chunk=c.recv(n-len(data))
        if not chunk: raise RuntimeError('closed')
        data+=chunk
    return data
def receive(c):
    cmd,a,b,n,crc,magic=struct.unpack('<6I',exact(c,24)); d=exact(c,n)
    assert magic == cmd ^ 0xffffffff and crc==sum(d) & 0xffffffff
    return cmd,a,b,d
def send(c,cmd,a,b,d=b'',bad=False):
    frame=struct.pack('<6I',cmd,a,b,len(d),(sum(d)+(1 if bad else 0)) & 0xffffffff,cmd ^ 0xffffffff)+d
    c.sendall(frame[:7]); c.sendall(frame[7:])
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run([str(binary),tmp],check=True)
    raw=base64.b64decode((pathlib.Path(tmp)/'public.txt').read_bytes().split(b' ')[0])
    assert len(raw)==524
    words,inv=struct.unpack('<II',raw[:8]); n=int.from_bytes(raw[8:264],'little'); rr=int.from_bytes(raw[264:520],'little'); e=int.from_bytes(raw[520:],'little')
    assert words==64 and e==65537 and (inv*n+1) % 2**32==0 and rr==pow(2,4096,n)
    def verify(sig,token):
        decoded=pow(int.from_bytes(sig,'big'),e,n).to_bytes(256,'big')
        suffix=bytes.fromhex('3021300906052b0e03021a05000414')+token
        assert decoded==b'\0\1'+b'\xff'*(256-len(suffix)-3)+b'\0'+suffix
    verify((pathlib.Path(tmp)/'signature.bin').read_bytes(),b'B'*20)
    for mode in ['trusted','new-key','bad-checksum','tls','closed-stream','oversized']:
        errors=[]
        with socket.socket() as server:
            server.bind(('127.0.0.1',0)); server.listen(); server.settimeout(20)
            def serve():
                try:
                    c,_=server.accept()
                    with c:
                        c.settimeout(15)
                        assert receive(c)[0]==CNXN
                        if mode=='tls': send(c,int.from_bytes(b'STLS','little'),1,0); return
                        send(c,AUTH,1,0,b'B'*20)
                        p=receive(c); assert p[:3]==(AUTH,2,0); verify(p[3],b'B'*20)
                        if mode=='new-key':
                            send(c,AUTH,1,0,b'C'*20)
                            p=receive(c); assert p[:3]==(AUTH,3,0) and p[3].endswith(b'\0')
                            assert base64.b64decode(p[3].split(b' ')[0])==raw
                        send(c,CNXN,0x01000000,4096,b'device::\0')
                        p=receive(c); assert p[0]==OPEN and p[3]==b'shell:echo bitora\0'; local=p[1]
                        if mode=='closed-stream': send(c,CLSE,0,local); receive(c); return
                        send(c,OKAY,7,local)
                        if mode=='oversized':
                            c.sendall(struct.pack('<6I',WRTE,7,local,4097,0,WRTE ^ 0xffffffff)); return
                        send(c,WRTE,7,local,b'bitora\n',mode=='bad-checksum')
                        if mode=='bad-checksum': return
                        assert receive(c)[:3]==(OKAY,local,7)
                        send(c,CLSE,7,local); assert receive(c)[:3]==(CLSE,local,7)
                except Exception as error: errors.append(error)
            thread=threading.Thread(target=serve); thread.start()
            result=subprocess.run([str(binary),tmp,str(server.getsockname()[1])],timeout=30)
            thread.join()
            assert not errors,errors
            assert (result.returncode==0)==(mode in ['trusted','new-key']),mode
            print('PASS',mode)
print('All RSA and ADB integration checks passed')
