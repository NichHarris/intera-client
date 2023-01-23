import React, { useRef } from 'react'
import socketio from 'socket.io-client'
// import styles from '../styles/VideoFeed.module.css'

export default function VideoFeedComponent(props) {
    const userVideo = useRef(null)
    const guestVideo = useRef(null)

    const s_webrtc = socketio('http://localhost:5000', {
        cors: {
            origin: 'http://localhost:3000',
            credentials: true,
        },
        transports: ['websocket'],
    })

    return (
        <div style={{ width: '-webkit-fill-available' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ textAlign: 'center' }}>
                    <h2>Host</h2>
                    <div>
                        <video style={{ width: '80%', height: 'auto' }} controls src=""></video>
                    </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                    <h2>Guest</h2>
                    <div>
                        <video style={{ width: '80%', height: 'auto' }} controls src=""></video>
                    </div>
                </div>
            </div>
        </div>
    )
}
