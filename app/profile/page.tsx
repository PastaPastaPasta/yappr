'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { 
  CameraIcon, 
  PencilIcon, 
  LinkIcon,
  MapPinIcon,
  CalendarIcon,
  Cog6ToothIcon,
  CheckIcon,
  XMarkIcon,
  ArrowLeftIcon,
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/lib/store'
import { formatNumber, cn } from '@/lib/utils'
import * as Dialog from '@radix-ui/react-dialog'
import * as Slider from '@radix-ui/react-slider'
import { 
  AvatarFeaturesV2, 
  AVATAR_PROPERTIES, 
  generateAvatarV2, 
  encodeAvatarFeaturesV2,
  decodeAvatarFeaturesV2,
  getAvatarDataURL
} from '@/lib/avatar-generator-v2'
import { AvatarCanvas } from '@/components/ui/avatar-canvas'
import toast from 'react-hot-toast'
import { withAuth, useAuth } from '@/contexts/auth-context'

function ProfilePage() {
  const { user } = useAuth()
  const [isEditingProfile, setIsEditingProfile] = useState(false)
  const [isEditingAvatar, setIsEditingAvatar] = useState(false)
  const [userPosts, setUserPosts] = useState<any[]>([])
  const [isLoadingPosts, setIsLoadingPosts] = useState(true)
  
  // Profile edit states
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [location, setLocation] = useState('')
  const [website, setWebsite] = useState('')
  
  // Avatar customization states
  const [avatarFeatures, setAvatarFeatures] = useState<AvatarFeaturesV2>(
    generateAvatarV2(user?.identityId || 'default')
  )
  
  const joinDate = new Date() // TODO: Get from identity registration
  
  // Load user posts
  useEffect(() => {
    if (!user) return
    
    const loadUserPosts = async () => {
      try {
        setIsLoadingPosts(true)
        const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
        const dashClient = getDashPlatformClient()
        
        // Query posts by author
        const posts = await dashClient.queryPosts({ 
          authorId: user.identityId,
          limit: 50 
        })
        
        // Transform posts to match our UI format
        const transformedPosts = posts.map((post: any) => ({
          id: post.$id,
          content: post.content,
          author: {
            id: post.authorId,
            username: user.identityId.slice(0, 8) + '...',
            handle: user.identityId.slice(0, 8).toLowerCase()
          },
          timestamp: new Date(post.$createdAt).toISOString(),
          likes: 0,
          replies: 0,
          reposts: 0,
          views: 0
        }))
        
        setUserPosts(transformedPosts)
      } catch (error) {
        console.error('Failed to load user posts:', error)
      } finally {
        setIsLoadingPosts(false)
      }
    }
    
    loadUserPosts()
  }, [user])
  
  const handleSaveProfile = () => {
    // Save profile changes
    toast.success('Profile updated successfully')
    setIsEditingProfile(false)
  }
  
  const handleSaveAvatar = () => {
    const encodedAvatar = encodeAvatarFeaturesV2(avatarFeatures)
    // Save avatar data
    toast.success('Avatar updated successfully')
    setIsEditingAvatar(false)
  }
  
  const handleRandomizeAvatar = () => {
    const randomFeatures = generateAvatarV2(Math.random().toString())
    setAvatarFeatures(randomFeatures)
  }
  
  const handleResetAvatar = () => {
    const defaultFeatures = generateAvatarV2(user?.identityId || 'default')
    setAvatarFeatures(defaultFeatures)
    toast.success('Avatar reset to default')
  }
  
  const updateAvatarFeature = (key: keyof AvatarFeaturesV2, value: number) => {
    setAvatarFeatures(prev => ({ ...prev, [key]: value }))
  }

  // Group properties by category
  const propertiesByCategory = Object.entries(AVATAR_PROPERTIES).reduce((acc, [key, config]) => {
    if (!acc[config.category]) {
      acc[config.category] = []
    }
    acc[config.category].push({ key: key as keyof AvatarFeaturesV2, ...config })
    return acc
  }, {} as Record<string, Array<{ key: keyof AvatarFeaturesV2 } & typeof AVATAR_PROPERTIES[keyof AvatarFeaturesV2]>>)

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <main className="flex-1 min-w-0 md:max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
        {/* Header */}
        <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-black/80 backdrop-blur-xl">
          <div className="flex items-center gap-4 px-4 py-3">
            <button className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900">
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
            <div className="flex-1">
              <h1 className="text-xl font-bold">{displayName || 'Profile'}</h1>
              <p className="text-sm text-gray-500">{userPosts.length} posts</p>
            </div>
          </div>
        </header>

        {/* Banner */}
        <div className="relative h-48 bg-gradient-yappr">
          <button className="absolute bottom-4 right-4 p-2 bg-black/50 rounded-full hover:bg-black/70 transition-colors">
            <CameraIcon className="h-5 w-5 text-white" />
          </button>
        </div>

        {/* Profile Info */}
        <div className="px-4 pb-4">
          <div className="relative flex justify-between items-start -mt-16 mb-4">
            <div className="relative">
              <div className="h-32 w-32 rounded-full bg-white dark:bg-black p-1">
                <div className="h-full w-full rounded-full overflow-hidden bg-gray-100 relative group">
                  <AvatarCanvas features={avatarFeatures} size={128} />
                  <button 
                    onClick={() => setIsEditingAvatar(true)}
                    className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                  >
                    <div className="text-center">
                      <CameraIcon className="h-8 w-8 text-white mx-auto mb-1" />
                      <span className="text-xs text-white font-medium">Edit Avatar</span>
                    </div>
                  </button>
                </div>
              </div>
            </div>
            
            <div className="mt-20">
              {isEditingProfile ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setIsEditingProfile(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleSaveProfile}>
                    Save
                  </Button>
                </div>
              ) : (
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setIsEditingProfile(true)}
                >
                  Edit profile
                </Button>
              )}
            </div>
          </div>

          {isEditingProfile ? (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Name</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  maxLength={50}
                />
              </div>
              
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Bio</label>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
                  rows={3}
                  maxLength={160}
                />
                <p className="text-xs text-gray-500 mt-1">{bio.length}/160</p>
              </div>
              
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Location</label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  maxLength={50}
                />
              </div>
              
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Website</label>
                <input
                  type="text"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://example.com"
                  className="mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500"
                  maxLength={100}
                />
              </div>
            </div>
          ) : (
            <>
              <div className="mb-3">
                <h2 className="text-xl font-bold">{displayName || user?.identityId.slice(0, 8) + '...'}</h2>
                <p className="text-gray-500">@{user?.identityId.slice(0, 8).toLowerCase() || 'loading...'}</p>
              </div>
              
              {bio && <p className="mb-3">{bio}</p>}
              
              <div className="flex flex-wrap gap-3 text-sm text-gray-500 mb-3">
                {location && (
                  <span className="flex items-center gap-1">
                    <MapPinIcon className="h-4 w-4" />
                    {location}
                  </span>
                )}
                {website && (
                  <a href={website} className="flex items-center gap-1 text-yappr-500 hover:underline">
                    <LinkIcon className="h-4 w-4" />
                    {website.replace(/^https?:\/\//, '')}
                  </a>
                )}
                <span className="flex items-center gap-1">
                  <CalendarIcon className="h-4 w-4" />
                  Joined {joinDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                </span>
              </div>
              
              <div className="flex gap-4 text-sm">
                <button className="hover:underline">
                  <span className="font-bold">{formatNumber(0)}</span>
                  <span className="text-gray-500"> Following</span>
                </button>
                <button className="hover:underline">
                  <span className="font-bold">{formatNumber(0)}</span>
                  <span className="text-gray-500"> Followers</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Additional Profile Actions */}
        <div className="border-t border-gray-200 dark:border-gray-800 p-6">
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="text-center p-4 rounded-lg bg-gray-50 dark:bg-gray-950">
              <h3 className="font-semibold text-lg mb-1">{formatNumber(userPosts.length)}</h3>
              <p className="text-sm text-gray-500">Posts</p>
            </div>
            <div className="text-center p-4 rounded-lg bg-gray-50 dark:bg-gray-950">
              <h3 className="font-semibold text-lg mb-1">{formatNumber(0)}</h3>
              <p className="text-sm text-gray-500">Followers</p>
            </div>
          </div>
          
          <div className="space-y-4">
            <h3 className="font-semibold text-lg">Quick Actions</h3>
            <button 
              onClick={() => setIsEditingAvatar(true)}
              className="w-full p-4 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors flex items-center gap-3"
            >
              <div className="h-10 w-10 rounded-full overflow-hidden bg-gray-100">
                <AvatarCanvas features={avatarFeatures} size={40} />
              </div>
              <div className="flex-1 text-left">
                <p className="font-medium">Customize Avatar</p>
                <p className="text-sm text-gray-500">Personalize your profile picture</p>
              </div>
              <PencilIcon className="h-5 w-5 text-gray-400" />
            </button>
            
            <button className="w-full p-4 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-yappr-100 dark:bg-yappr-950 flex items-center justify-center">
                <LinkIcon className="h-5 w-5 text-yappr-500" />
              </div>
              <div className="flex-1 text-left">
                <p className="font-medium">Share Profile</p>
                <p className="text-sm text-gray-500">Get your profile link</p>
              </div>
            </button>
            
            <button className="w-full p-4 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-gray-100 dark:bg-gray-900 flex items-center justify-center">
                <Cog6ToothIcon className="h-5 w-5 text-gray-600" />
              </div>
              <div className="flex-1 text-left">
                <p className="font-medium">Account Settings</p>
                <p className="text-sm text-gray-500">Manage your account</p>
              </div>
            </button>
          </div>
        </div>
      </main>

      <RightSidebar />

      {/* Avatar Customization Modal */}
      <Dialog.Root open={isEditingAvatar} onOpenChange={setIsEditingAvatar}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-5xl max-h-[90vh] bg-white dark:bg-black rounded-2xl shadow-xl z-50 overflow-hidden">
            <div className="flex h-full">
              {/* Fixed Preview Side */}
              <div className="w-1/3 bg-gray-50 dark:bg-gray-950 p-8 flex flex-col items-center justify-center sticky top-0">
                <h3 className="text-lg font-semibold mb-6">Live Preview</h3>
                <div className="w-56 h-56 rounded-full overflow-hidden bg-white shadow-lg mb-6">
                  <AvatarCanvas features={avatarFeatures} size={224} />
                </div>
                <p className="text-sm text-gray-500 mb-4">Your avatar updates in real-time</p>
                <div className="space-y-2 w-full">
                  <Button onClick={handleRandomizeAvatar} variant="outline" size="sm" className="w-full">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                    </svg>
                    Randomize
                  </Button>
                  <Button onClick={handleResetAvatar} variant="ghost" size="sm" className="w-full">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
                    </svg>
                    Reset to Default
                  </Button>
                </div>
              </div>

              {/* Controls Side */}
              <div className="flex-1 p-6 overflow-y-auto">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl font-bold">Customize Your Avatar</h2>
                  <button
                    onClick={() => setIsEditingAvatar(false)}
                    className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full"
                  >
                    <XMarkIcon className="h-5 w-5" />
                  </button>
                </div>

                <div className="space-y-8">
                  {Object.entries(propertiesByCategory).map(([category, properties]) => (
                    <div key={category} className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
                      <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
                        {category}
                        <span className="text-xs text-gray-500">({properties.length} options)</span>
                      </h3>
                      <div className="space-y-4">
                        {properties.map(({ key, label, min, max, step }) => {
                          const defaultValue = generateAvatarV2(user?.identityId || 'default')[key]
                          const isModified = avatarFeatures[key] !== defaultValue
                          
                          return (
                            <div key={key} className={cn(
                              "p-3 rounded-lg transition-colors",
                              isModified && "bg-yappr-50 dark:bg-yappr-950/20"
                            )}>
                              <div className="flex items-center justify-between mb-2">
                                <label className="text-sm font-medium flex items-center gap-2">
                                  {label}
                                  {isModified && (
                                    <span className="text-xs text-yappr-500">• modified</span>
                                  )}
                                </label>
                                <span className="text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 px-2 py-1 rounded">
                                  {avatarFeatures[key]}
                                </span>
                              </div>
                              <Slider.Root
                                className="relative flex items-center select-none touch-none w-full h-5"
                                value={[avatarFeatures[key]]}
                                onValueChange={([value]) => updateAvatarFeature(key, value)}
                                max={max}
                                min={min}
                                step={step}
                              >
                                <Slider.Track className="bg-gray-200 dark:bg-gray-800 relative grow rounded-full h-2">
                                  <Slider.Range className="absolute bg-yappr-500 rounded-full h-full" />
                                </Slider.Track>
                                <Slider.Thumb className="block w-5 h-5 bg-white dark:bg-gray-200 shadow-lg rounded-full hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-yappr-500 cursor-grab active:cursor-grabbing" />
                              </Slider.Root>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex gap-3 mt-8 pt-6 border-t border-gray-200 dark:border-gray-800">
                  <Button variant="outline" onClick={() => setIsEditingAvatar(false)} className="flex-1">
                    Cancel
                  </Button>
                  <Button onClick={handleSaveAvatar} className="flex-1">
                    Save Avatar
                  </Button>
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

export default withAuth(ProfilePage)