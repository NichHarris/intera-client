import { React, useState, useEffect, useRef } from 'react'
import { ConfigProvider, Button, Spin, message, notification } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import '@babel/polyfill'
import { useRouter } from 'next/router'
import { useUser } from '@auth0/nextjs-auth0/client'
import auth0 from '../../auth/auth0'
import LoadingComponent from '../../components/LoadingComponent'
import HeaderComponent from '../../components/HeaderComponent'
// import VideoFeedComponent from '../../components/VideoFeedComponent'
import { theme } from '../../core/theme'
import { getQuery } from '../../core/utils'
import HistoryComponent from '../../components/HistoryComponent'
import ChatboxComponent from '../../components/ChatboxComponent'
import useTranscriptHistory from '../../hooks/useTranscriptHistory'
import useRoomInfo from '../../hooks/useRoomInfo'
import styles from '../../styles/CallPage.module.css'
import fetcher from '../../core/fetcher'
import socketio from 'socket.io-client'
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition'

/*
How call page should work:

Host creates the room and is added
Host is prompted to enable their video camera (if they are Speaker, they are also prompted for audio)
When video camera is enabled, video feed will be displayed
User can now send messages and do actions (i.e STT or ASL) for their role while they wait for the other user

When guest user joins (they should already be added to the room on the backend, this action should be done on "join room")
Guest is prompted to enable their video camera (if they are Speaker, they are also prompted for audio)
When video camera is enabled, video feed will be displayed
A socket ping will be sent out to the other user in the room to notify them that the other user has joined,
a mutate will occur to update the room info. When this happens the peerConnection process should begin

We should now begin to initializePeerConnection
The remote and local video feeds should be set on both guest and host
When this occurs, both feeds should appear

Socket pings for ready state, data_transfer, offer, answer, candidate should occur
When the remote video stream can be found onTrack, the remote video feed should be set and appear
*/

export default function CallPage({ accessToken }) {
    const userVideo = useRef({})
    const videoStream = useRef(null)
    const remoteVideo = useRef(null)
    const [isLocalVideoEnabled, setIsLocalVideoEnabled] = useState(false)
    const [isRemoteVideoEnabled, setIsRemoteVideoEnabled] = useState(false)
    const [userRole, setUserRole] = useState(null)
    const { transcript, resetTranscript, browserSupportsSpeechRecognition } = useSpeechRecognition()
    const [spaceBarPressed, setSpaceBarPressed] = useState(false)
    const router = useRouter()
    const roomID = getQuery(router, 'room_id')
    const [initialized, setInitialized] = useState(false)
    const { user, error, isLoading } = useUser()
    const [remoteNickname, setRemoteNickname] = useState(null)
    const [api, contextHolder] = notification.useNotification()
    let peerConnection

    const [spaceCheck, setSpaceBoolCheck] = useState(false)
    const [latestTranscript, setLatestTranscript] = useState('')
    const [lastTranscript, setLastTranscript] = useState('')

    const servers = {
        iceServers: [
            {
                urls: 'stun:relay.metered.ca:80',
            },
            {
                urls: 'turn:relay.metered.ca:80',
                username: `${process.env.TURN_USER}`,
                credential: `${process.env.TURN_PASSWORD}`,
            },
            {
                urls: 'turn:relay.metered.ca:443',
                username: `${process.env.TURN_USER}`,
                credential: `${process.env.TURN_USER}`,
            },
            {
                urls: 'turn:relay.metered.ca:443?transport=tcp',
                username: `${process.env.TURN_USER}`,
                credential: `${process.env.TURN_USER}`,
            },
        ],
    }

    if (!browserSupportsSpeechRecognition) {
        api.error({
            message: 'Browser does not support speech to text, please use Chrome',
            maxCount: 0,
        })
    }

    // SWR hooks
    const { data: transcriptHistory, error: transcriptHistoryError } = useTranscriptHistory(
        user ? user?.nickname : '',
        accessToken
    )
    const {
        data: roomInfo,
        error: roomInfoError,
        mutate: roomInfoMutate,
    } = useRoomInfo(roomID || '', accessToken)

    const getVideoPlaceholder = () => {
        return (
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <div
                    style={{
                        width: '55%',
                        aspectRatio: 'auto 4 / 3',
                        border: '2px solid #f0f0f0',
                    }}
                >
                    <div style={{ position: 'relative', top: '40%' }}>
                        <Spin
                            indicator={
                                <LoadingOutlined
                                    style={{
                                        fontSize: 40,
                                    }}
                                    spin
                                />
                            }
                        />
                    </div>
                </div>
            </div>
        )
    }

    /* ----------------------Socket---------------------- */

    const socket = socketio(`${process.env.API_URL}` || 'http://localhost:5000', {
        cors: {
            origin: `${process.env.CLIENT_URL}` || 'http://localhost:3000',
            credentials: true,
        },
        transports: ['websocket'],
        autoConnect: false,
    })

    const handleMutate = () => {
        socket.emit('mutate', { roomID: roomID })
        roomInfoMutate()
    }

    // leave conditions:
    // host leaves -> room closes, forces other user out
    // guest leaves -> room stays open, other user is notified, video stream closes, peerConnection resets
    const handleLeave = async () => {
        socket.emit('leave', { room_id: roomID, user: user?.nickname })
        // close video stream
        if (userVideo?.current?.srcObject) {
            const userStream = userVideo.current.srcObject

            // Reset peerConnection
            if (peerConnection) {
                peerConnection.removeTrack(userStream)
                peerConnection.close()
                peerConnection = null
            }
            userVideo.current.srcObject.getTracks().forEach((track) => track.stop())
        }

        // Close the room
        if (roomInfo?.users[0] == user?.nickname) {
            fetcher(accessToken, '/api/rooms/close_room', {
                method: 'PUT',
                body: JSON.stringify({
                    room_id: roomID,
                }),
            }).then((res) => {
                if (res.status == 200) {
                    console.log('Room closed')
                }
            })
        }

        // signal other user to reset name, notify user has left, and close video stream/peerConnection
        router.push('/')
    }

    /* ----------------------STT---------------------- */

    // User input for push to talk
    useEffect(() => {
        const handleKeyPress = (event) => {
            if (event.keyCode === 32 && !spaceBarPressed && userRole === 'STT') {
                setSpaceBoolCheck(false)
                SpeechRecognition.startListening({ continuous: true })
                setSpaceBarPressed(true)
                message.info({
                    key: 'STT',
                    content: 'Speech recording started...',
                })
            }
        }
        const handleKeyRelease = (event) => {
            if (event.keyCode === 32 && spaceBarPressed && userRole === 'STT') {
                SpeechRecognition.stopListening()
                setSpaceBarPressed(false)
                setTimeout(() => {
                    resetTranscript()
                    setSpaceBoolCheck(true)
                }, 500)

                message.success({
                    key: 'STT',
                    content: 'Speech recording finished...',
                })
            }
        }
        document.addEventListener('keydown', handleKeyPress)
        document.addEventListener('keyup', handleKeyRelease)
        return () => {
            document.removeEventListener('keydown', handleKeyPress)
            document.removeEventListener('keyup', handleKeyRelease)
        }
    }, [spaceBarPressed, userRole])

    useEffect(() => {
        setLatestTranscript(transcript)
    }, [spaceCheck, transcript])

    useEffect(() => {
        if (spaceCheck) {
            if (latestTranscript !== lastTranscript) {
                if (latestTranscript != '') {
                    appendMessage(latestTranscript)
                }
                setLastTranscript(latestTranscript)
            }
        }
    }, [spaceCheck, latestTranscript, lastTranscript])

    // Add a STT message
    const appendMessage = async (message) => {
        fetcher(accessToken, '/api/transcripts/create_message', {
            method: 'POST',
            body: JSON.stringify({
                room_id: roomInfo.room_id,
                to_user: roomInfo.users.find((username) => username !== user.nickname) || 'N/A',
                message: message,
                type: getType(),
            }),
        })
            .then((res) => {
                if (res.status == 200) {
                    // Emit mutate message over websocket to other user
                    handleMutate()
                } else {
                    api.error({
                        message: `Error ${res.status}: ${res.error}`,
                    })
                }
            })
            .catch((res) => {
                api.error({
                    message: 'An unknown error has occurred',
                })
            })
    }

    // Refresh chatbox for both users upon invalidation
    const invalidateRefresh = async () => {
        handleMutate()
    }

    /* ----------------------Video---------------------- */

    const initializeLocalVideo = async () => {
        navigator.mediaDevices
            .getUserMedia({
                audio: true,
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                },
            })
            .then((stream) => {
                userVideo.current.srcObject = stream
                setIsLocalVideoEnabled(true)

                if (userRole === 'ASL') {
                    // Create media recorder, and set the stream to it
                    const mediaRecorderObject = new MediaRecorder(stream, {
                        mimeType: 'video/mp4',
                    })
                    videoStream.current = mediaRecorderObject

                    // Send stream buffer to server
                    videoStream.current.ondataavailable = (e) => {
                        if (typeof e.data !== 'undefined' && e.data.size !== 0) {
                            const recordedChunk = new Blob([e.data], { type: 'video/mp4' })
                            socket.emit('stream_buffer', {
                                user: user?.nickname,
                                room_id: roomID,
                                data: recordedChunk,
                            })
                        }
                    }

                    videoStream.current.start(2000)
                }

                socket.connect()
            })
            .catch((error) => {
                console.error('Stream not found:: ', error)
            })
    }

    // Get the communication type of the user
    const getType = () => {
        if (userRole == null) {
            if (roomInfo?.users[0] === user?.nickname) {
                return roomInfo?.host_type
            } else {
                if (roomInfo?.host_type === 'ASL') {
                    return 'STT'
                } else {
                    return 'ASL'
                }
            }
        }

        return userRole
    }

    /* ----------------------RTC---------------------- */

    // RTC Connection Reference: https://www.100ms.live/blog/webrtc-python-react
    // *************************************************************************
    const onIceCandidate = (event) => {
        if (event.candidate) {
            dataTransfer({
                type: 'candidate',
                candidate: event.candidate,
            })
        }
    }

    const onTrack = (event) => {
        setIsRemoteVideoEnabled(true)
        remoteVideo.current.srcObject = event.streams[0]
    }

    const onClose = () => {
        console.log('Connection closed')
    }

    const initializePeerConnection = () => {
        try {
            peerConnection = new RTCPeerConnection(servers)
            peerConnection.onicecandidate = onIceCandidate
            peerConnection.ontrack = onTrack
            peerConnection.onclose = onClose
            const userStream = userVideo.current.srcObject
            for (const track of userStream?.getTracks()) {
                peerConnection.addTrack(track, userStream)
            }
        } catch (error) {
            console.error('Failed to establish connection: ', error)
        }
    }

    const setAndSendLocalDescription = (sessionDescription) => {
        peerConnection.setLocalDescription(sessionDescription)
        dataTransfer(sessionDescription)
    }

    const sendOffer = () => {
        peerConnection.createOffer().then(setAndSendLocalDescription, (error) => {
            console.error('Unable to send offer: ', error)
        })
    }

    const sendAnswer = () => {
        peerConnection.createAnswer().then(setAndSendLocalDescription, (error) => {
            console.error('Unable to send answer: ', error)
        })
    }

    const handleDataTransfer = (data) => {
        if (data.type === 'offer') {
            setRemoteNickname(roomInfo?.users?.find((username) => username !== user?.nickname))
            initializePeerConnection()
            peerConnection.setRemoteDescription(new RTCSessionDescription(data))
            sendAnswer()
        } else if (data.type === 'answer') {
            peerConnection?.setRemoteDescription(new RTCSessionDescription(data))
        } else if (data.type === 'candidate') {
            peerConnection?.addIceCandidate(new RTCIceCandidate(data.candidate))
        } else {
            console.log('Unrecognized data received...')
        }
    }
    // *************************************************************************

    /* ----------------------Signaling---------------------- */

    const dataTransfer = (data) => {
        socket.emit('data_transfer', {
            user: user?.nickname,
            room_id: roomID,
            body: data,
        })
    }

    socket.on('data_transfer', (data) => {
        handleDataTransfer(data.body)
    })

    // Following a succesful join, establish a peer connection
    // and send an offer to the other user
    socket.on('ready', (data) => {
        initializePeerConnection()
        sendOffer()
    })

    socket.on('connect', (data) => {
        if (!data && !initialized) {
            setInitialized(true)
            socket.emit('join', { user: user?.nickname, room_id: roomID })
        }
    })

    // Following a succesful join, establish a peer connection
    // and send an offer to the other user
    socket.on('mutate', (data) => {
        roomInfoMutate()
    })

    // Following a succesful join, establish a peer connection
    // and send an offer to the other user
    socket.on('ready', (data) => {
        roomInfoMutate()
    })

    socket.on('stream_buffer_response', (data) => {
        // console.log('RECEIVED STREAM BUFFER DATA', data)
    })

    socket.on('disconnect', (data) => {
        setRemoteNickname(null)
        setIsRemoteVideoEnabled(false)
    })

    socket.on('leave', (data) => {
        if (data.user == user?.nickname) {
            handleLeave()
        }
    })

    /* ----------------------Setup---------------------- */

    useEffect(() => {
        if (
            !remoteNickname &&
            typeof user?.nickname !== 'undefined' &&
            typeof roomInfo !== 'undefined' &&
            roomInfo.users.length == 2
        ) {
            setUserRole(getType())
            setRemoteNickname(roomInfo.users.find((username) => username !== user.nickname))
        }

        if (
            !initialized &&
            typeof transcriptHistory !== 'undefined' &&
            typeof roomInfo !== 'undefined' &&
            typeof user?.nickname !== undefined &&
            roomInfo?.active == true
        ) {
            setUserRole(getType())
            if (roomInfo?.users.length == 2) {
                setRemoteNickname(roomInfo.users.find((username) => username !== user.nickname))
            }
        }

        if (roomInfo && !roomInfo?.active) {
            handleLeave()
        }
    }, [roomInfo, user, initialized])

    useEffect(() => {
        if (transcriptHistoryError?.status == 401) {
            router.push('/api/auth/logout')
        } else if (roomInfoError?.status == 404) {
            // If room ID is invalid, redirect to home page
            router.push(`/?invalid_room=${roomID}`)
        } else if (typeof roomInfo !== 'undefined' && roomInfo?.active == false) {
            // If room ID is expired, redirect to home page
            router.push(`/?expired_room=${roomID}`)
        } else if (
            typeof roomInfo !== 'undefined' &&
            roomInfo?.users.length == 2 &&
            user?.nickname &&
            !roomInfo?.users.find((name) => name === user?.nickname)
        ) {
            // If room if full, redirect to home page
            router.push(`/?full_room=${roomID}`)
        }
    }, [roomInfo, user, transcriptHistoryError, roomInfoError])

    useEffect(() => {
        initializeLocalVideo()

        return function cleanup() {
            peerConnection?.close()
        }
    }, [])

    if (user && !isLoading) {
        return (
            <ConfigProvider theme={theme}>
                <HeaderComponent user={user} roomID={roomID} handleLeave={handleLeave} />
                <div className={styles.callWrapper}>
                    <div style={{ width: '20%' }}>
                        <Button
                            style={{ position: 'absolute', left: 10, top: 46 }}
                            onClick={() => appendMessage('Example message')}
                        >
                            Send Message (temporary)
                        </Button>
                        <HistoryComponent transcripts={transcriptHistory} user={user} />
                    </div>
                    <div style={{ width: '40%' }}>
                        <ChatboxComponent
                            accessToken={accessToken}
                            context={'call'}
                            roomInfo={roomInfo}
                            roomID={roomID}
                            invalidateRefresh={invalidateRefresh}
                            transcript={
                                roomInfo?.messages_info.length > 0 ? roomInfo?.messages_info : []
                            }
                            user={user}
                        />
                    </div>
                    <div style={{ width: '40%' }}>
                        <div style={{ width: '-webkit-fill-available' }}>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <div style={{ textAlign: 'center' }}>
                                    <h2 style={{ marginBottom: 10 }}>
                                        {remoteNickname ? (
                                            <span>
                                                <span>{remoteNickname}</span>
                                                <span>{` (${
                                                    userRole === 'ASL' ? 'Speaker' : 'ASL Signer'
                                                })`}</span>
                                            </span>
                                        ) : (
                                            <span className={styles.remoteUserLoading}>
                                                Awaiting user connection<span>.</span>
                                                <span>.</span>
                                                <span>.</span>
                                            </span>
                                        )}
                                    </h2>
                                    <div>
                                        <video
                                            autoPlay
                                            muted
                                            playsInline
                                            ref={remoteVideo}
                                            style={{
                                                display: isRemoteVideoEnabled ? 'inline' : 'none',
                                                width: '55%',
                                                height: isRemoteVideoEnabled ? '55%' : 0,
                                            }}
                                        ></video>
                                        {!isRemoteVideoEnabled && getVideoPlaceholder()}
                                    </div>
                                </div>
                                <div style={{ textAlign: 'center' }}>
                                    <h2 style={{ marginBottom: 10 }}>{`${user?.nickname} (${
                                        userRole === 'ASL' ? 'ASL Signer' : 'Speaker'
                                    })`}</h2>
                                    <div>
                                        <video
                                            autoPlay={true}
                                            muted
                                            playsInline
                                            ref={userVideo}
                                            style={{
                                                display: isLocalVideoEnabled ? 'inline' : 'none',
                                                width: '55%',
                                                height: isLocalVideoEnabled ? '55%' : 0,
                                            }}
                                        ></video>
                                        {!isLocalVideoEnabled && getVideoPlaceholder()}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </ConfigProvider>
        )
    } else if (isLoading) {
        return <LoadingComponent msg="Loading..." />
    } else if (!user && !isLoading) {
        router.push('/api/auth/login')
    }
}

export const getServerSideProps = async (context) => {
    let accessToken = (await auth0.getSession(context.req, context.res)) || null
    if (accessToken != null) {
        accessToken = accessToken.idToken
    }
    return { props: { accessToken } }
}
