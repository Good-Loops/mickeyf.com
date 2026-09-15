import React from 'react';

// Files providers may identify audio by its extension rather than an audio MIME type.
// These are picker hints, not a guarantee that the browser can decode every codec.
const AUDIO_FILE_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.wav,.wave,.aif,.aiff,.flac,.ogg,.oga,.opus,.caf,.weba';

type MusicUploadProps = {
    id: string;
    classPrefix: string;
    onFileSelect: (file: File) => void;
};

/** Shared file selection UI; loading and playback belong to the caller. */
export default function MusicUpload({ id, classPrefix, onFileSelect }: MusicUploadProps) {
    const handleKeyDown = (event: React.KeyboardEvent<HTMLLabelElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;

        event.preventDefault();
        event.currentTarget.control?.click();
    };

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.currentTarget.files?.[0];
        if (file) onFileSelect(file);
    };

    return (
        <div className={`${classPrefix}__upload`}>
            <label
                className={`${classPrefix}__upload-btn`}
                htmlFor={id}
                role="button"
                tabIndex={0}
                onKeyDown={handleKeyDown}
            >
                Upload Music
            </label>
            <input
                id={id}
                type="file"
                accept={AUDIO_FILE_ACCEPT}
                className={`${classPrefix}__input`}
                onChange={handleChange}
            />
        </div>
    );
}
